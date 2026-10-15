import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderModelConfig,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

/** The custom API id is intentionally not an HTTP API: it is backed by `agy`. */
export const ANTIGRAVITY_API = "antigravity-cli" as Api;
export const ANTIGRAVITY_PROVIDER = "antigravity";

const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_PRINT_TIMEOUT = "24h";
const FALLBACK_MODELS = [
	["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
	["gemini-4-argon-high", "Gemini 4 Argon (High)"],
	["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
	["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
	["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
	["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
	["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
	["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"],
	["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
	["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
	["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"],
	["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
	["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
] as const;

interface RawUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
}

interface StreamInput {
	event: "user";
	message: {
		role: "user";
		content: string;
	};
}

interface AgyResult {
	status?: string;
	response?: string;
	error?: string;
	usage?: Record<string, unknown>;
}

interface AgyStreamEvent {
	event?: string;
	conversation_id?: string;
	init?: Record<string, unknown>;
	step_update?: {
		step_type?: string;
		state?: string;
		text_delta?: string;
		usage?: Record<string, unknown>;
	};
	result?: AgyResult;
}

class LineReader {
	private readonly readline: ReadlineInterface;
	private readonly buffered: string[] = [];
	private readonly waiters: Array<(line: string | null) => void> = [];
	private closed = false;

	constructor(stream: NodeJS.ReadableStream) {
		this.readline = createInterface({ input: stream });
		this.readline.on("line", (line) => {
			const waiter = this.waiters.shift();
			if (waiter) waiter(line);
			else this.buffered.push(line);
		});
		this.readline.on("close", () => {
			this.closed = true;
			while (this.waiters.length > 0) this.waiters.shift()!(null);
		});
	}

	async next(): Promise<string | null> {
		if (this.buffered.length > 0) return this.buffered.shift()!;
		if (this.closed) return null;
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	close(): void {
		this.readline.close();
	}
}

interface AgyProcess {
	key: string;
	modelId: string;
	child: ChildProcessWithoutNullStreams;
	reader: LineReader;
	logDir: string;
	stderr: string;
	closed: boolean;
	destroyed: boolean;
	turns: number;
	contextMessageCount: number;
	systemSignature: string;
	cumulativeUsage: RawUsage;
}

const processes = new Map<string, AgyProcess>();
const turnLocks = new Map<string, Promise<void>>();

function emptyRawUsage(): RawUsage {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		total_tokens: 0,
	};
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseUsage(value: Record<string, unknown> | undefined): RawUsage {
	return {
		input_tokens: numberField(value?.input_tokens),
		output_tokens: numberField(value?.output_tokens),
		cache_read_tokens: numberField(value?.cache_read_tokens),
		cache_write_tokens: numberField(value?.cache_write_tokens),
		total_tokens: numberField(value?.total_tokens),
	};
}

function subtractUsage(current: RawUsage, previous: RawUsage): RawUsage {
	const fields = Object.keys(current) as Array<keyof RawUsage>;
	const reset = fields.some((field) => current[field] < previous[field]);
	if (reset) return current;
	const result = emptyRawUsage();
	for (const field of fields) result[field] = current[field] - previous[field];
	return result;
}

function usageFromRaw(raw: RawUsage): Usage {
	const totalTokens = raw.total_tokens ||
		raw.input_tokens + raw.output_tokens + raw.cache_read_tokens + raw.cache_write_tokens;
	return {
		input: raw.input_tokens,
		output: raw.output_tokens,
		cacheRead: raw.cache_read_tokens,
		cacheWrite: raw.cache_write_tokens,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const value = block as Record<string, unknown>;
			if (value.type === "text" && typeof value.text === "string") return value.text;
			if (value.type === "image") return "[image attachment omitted: agy print input is text-only]";
			if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
			if (value.type === "toolCall") {
				const name = typeof value.name === "string" ? value.name : "tool";
				const args = value.arguments === undefined ? "" : ` ${JSON.stringify(value.arguments)}`;
				return `[${name}${args}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function renderMessage(message: Record<string, unknown>): string {
	const role = typeof message.role === "string" ? message.role : "message";
	const text = contentText(message.content);
	if (role === "toolResult") {
		const name = typeof message.toolName === "string" ? ` (${message.toolName})` : "";
		return `[PI TOOL RESULT${name}]\n${text || "(empty tool result)"}`;
	}
	if (role === "assistant") return `[PI ASSISTANT]\n${text || "(empty assistant message)"}`;
	if (role === "user") return `[PI USER]\n${text || "(empty user message)"}`;
	return `[${role.toUpperCase()}]\n${text}`;
}

function nonSystemMessages(context: TranscriptContext): Array<Record<string, unknown>> {
	return context.messages.filter((message) => message.role !== "system") as Array<Record<string, unknown>>;
}

function systemSignature(context: TranscriptContext): string {
	return JSON.stringify(
		context.messages
			.filter((message) => message.role === "system")
			.map((message) => {
				const value = message as unknown as Record<string, unknown>;
				return {
					content: value.content,
					sections: value.sections,
					toolsAdded: Array.isArray(value.toolsAdded)
						? value.toolsAdded.map((tool: Record<string, unknown>) => tool.name)
						: undefined,
					toolsRemoved: value.toolsRemoved,
				};
			}),
	);
}

function systemText(context: TranscriptContext): string {
	return (context.messages as unknown as Array<Record<string, unknown>>)
		.filter((message) => message.role === "system")
		.map((message) => {
			let text = contentText(message.content);
			const sections = message.sections;
			if (sections && typeof sections === "object") {
				for (const [name, value] of Object.entries(sections as Record<string, unknown>)) {
					if (typeof value === "string" && value.trim()) text += `\n[${name}]\n${value}`;
				}
			}
			return text;
		})
		.filter(Boolean)
		.join("\n\n");
}

function bootstrapPrompt(context: TranscriptContext): string {
	const guidance = systemText(context);
	const messages = nonSystemMessages(context).map(renderMessage).join("\n\n");
	return [
		"You are the Antigravity model running behind the Pi coding assistant.",
		"Work on the current workspace and answer the latest request directly. You may use your own Antigravity tools when useful.",
		"The text below is the existing Pi transcript. Treat it as context, not as a new instruction to explain the wrapper.",
		guidance ? `\n<pi-system-guidance>\n${guidance}\n</pi-system-guidance>` : "",
		`\n<pi-transcript>\n${messages || "(empty)"}\n</pi-transcript>`,
		"Continue from the transcript and produce the assistant's next response.",
	]
		.filter(Boolean)
		.join("\n");
}

function turnPrompt(process: AgyProcess, context: TranscriptContext): string {
	if (process.turns === 0) return bootstrapPrompt(context);
	const messages = nonSystemMessages(context);
	if (messages.length < process.contextMessageCount) return bootstrapPrompt(context);

	const delta = messages
		.slice(process.contextMessageCount)
		.filter((message) => message.role !== "assistant")
		.map(renderMessage)
		.join("\n\n");
	if (delta.trim()) {
		return `Continue the current Pi task with this new context:\n\n${delta}`;
	}
	return "Continue the current task and provide the next assistant response.";
}

function parseShellArgs(value: string): string[] {
	const args: string[] = [];
	const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
	for (const match of value.matchAll(pattern)) {
		const raw = match[1] ?? match[2] ?? match[3] ?? "";
		args.push(raw.replace(/\\([\\"'])/g, "$1"));
	}
	return args;
}

function environmentFor(options?: SimpleStreamOptions): NodeJS.ProcessEnv {
	return {
		...process.env,
		...(options?.env ?? {}),
	};
}

function effortArg(reasoning: SimpleStreamOptions["reasoning"]): string | undefined {
	if (!reasoning || reasoning === "off") return undefined;
	return reasoning === "minimal" ? "low" : reasoning;
}

async function collectCommand(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			if (timeout) clearTimeout(timeout);
			resolve(result);
		};
		const abort = () => {
			child.kill("SIGTERM");
			finish({ code: null, stdout, stderr });
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			if (!settled) {
				settled = true;
				signal?.removeEventListener("abort", abort);
				if (timeout) clearTimeout(timeout);
				reject(error);
			}
		});
		child.once("close", (code) => finish({ code, stdout, stderr }));
		timeout = setTimeout(() => {
			child.kill("SIGTERM");
			finish({ code: null, stdout, stderr });
		}, 15_000);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

function modelConfig(id: string, name: string): ProviderModelConfig {
	const hasEmbeddedEffort = /-(low|medium|high|xhigh|max)$/i.test(id);
	return {
		id,
		name,
		api: ANTIGRAVITY_API,
		input: ["text"],
		// Current `agy models` ids already encode the effort (for example
		// `gemini-4-argon-high`). Mark those models as non-reasoning so Pi does
		// not inject its default `--thinking medium`, which conflicts with the
		// model id. Users select low/medium/high by selecting the corresponding
		// Antigravity model.
		reasoning: !hasEmbeddedEffort,
		contextWindow: Number(process.env.ANTIGRAVITY_CONTEXT_WINDOW) || DEFAULT_CONTEXT_WINDOW,
		maxTokens: Number(process.env.ANTIGRAVITY_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
		// Antigravity CLI access is subscription/local-account based; no public per-token
		// price is known here, so usage is reported without inventing a cost.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function parseModelOutput(output: string): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = [];
	const seen = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.toLowerCase().startsWith("fetching ")) continue;
		const match = trimmed.match(/^([^\s]+)(?:\t+|\s{2,})(.+)$/);
		if (!match) continue;
		const [, id, name] = match;
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id) || seen.has(id)) continue;
		seen.add(id);
		models.push(modelConfig(id, name.trim()));
	}
	return models;
}

function fallbackModelConfigs(): ProviderModelConfig[] {
	return FALLBACK_MODELS.map(([id, name]) => modelConfig(id, name));
}

export async function discoverModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	try {
		const result = await collectCommand("agy", ["models"], environmentFor(), signal);
		const models = parseModelOutput(`${result.stdout}\n${result.stderr}`);
		if (models.length > 0) return models;
	} catch {
		// Keep the provider visible so a missing/broken installation has a useful
		// error at request time instead of silently disappearing from /model.
	}
	return fallbackModelConfigs();
}

async function createProcess(
	key: string,
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): Promise<AgyProcess> {
	const env = environmentFor(options);
	const logDir = await mkdtemp(join(tmpdir(), "pi-antigravity-"));
	const args = [
		"--add-dir",
		process.cwd(),
		"--model",
		model.id,
		"--output-format",
		"stream-json",
		"--input-format",
		"stream-json",
		"--print-timeout",
		env.AGY_PRINT_TIMEOUT || DEFAULT_PRINT_TIMEOUT,
		"--log-file",
		join(logDir, "agy.log"),
	];
	const effort = effortArg(options?.reasoning);
	if (effort) args.push("--effort", effort);
	if (env.ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS === "1" || env.AGY_DANGEROUSLY_SKIP_PERMISSIONS === "1") {
		args.push("--dangerously-skip-permissions");
	}
	if (env.AGY_EXTRA_ARGS) args.push(...parseShellArgs(env.AGY_EXTRA_ARGS));

	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn("agy", args, {
			cwd: process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		await rm(logDir, { recursive: true, force: true });
		throw error;
	}

	const processState: AgyProcess = {
		key,
		modelId: model.id,
		child,
		reader: new LineReader(child.stdout),
		logDir,
		stderr: "",
		closed: false,
		destroyed: false,
		turns: 0,
		contextMessageCount: 0,
		systemSignature: "",
		cumulativeUsage: emptyRawUsage(),
	};
	child.stderr.on("data", (chunk: Buffer) => {
		processState.stderr = `${processState.stderr}${chunk.toString()}`.slice(-8_000);
	});
	child.once("close", () => {
		processState.closed = true;
		processState.reader.close();
		if (processes.get(key) === processState) processes.delete(key);
	});
	child.once("error", () => {
		processState.closed = true;
		if (processes.get(key) === processState) processes.delete(key);
	});
	return processState;
}

async function destroyProcess(processState: AgyProcess): Promise<void> {
	if (processState.destroyed) return;
	processState.destroyed = true;
	if (processes.get(processState.key) === processState) processes.delete(processState.key);
	processState.reader.close();
	if (!processState.closed) {
		processState.child.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (!processState.closed) processState.child.kill("SIGKILL");
	}
	await rm(processState.logDir, { recursive: true, force: true });
}

async function ensureProcess(
	key: string,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
): Promise<AgyProcess> {
	const signature = systemSignature(context);
	let processState = processes.get(key);
	const mustRestart =
		!processState ||
		processState.closed ||
		processState.destroyed ||
		processState.modelId !== model.id ||
		(processState.turns > 0 && processState.systemSignature !== signature) ||
		(processState.turns > 0 && nonSystemMessages(context).length < processState.contextMessageCount);
	if (mustRestart && processState) await destroyProcess(processState);
	processState = processes.get(key);
	if (!processState) {
		processState = await createProcess(key, model, options);
		processes.set(key, processState);
	}
	return processState;
}

async function withTurnLock<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = turnLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chain = previous.then(() => current);
	turnLocks.set(key, chain);
	await previous;
	try {
		return await work();
	} finally {
		release();
		if (turnLocks.get(key) === chain) turnLocks.delete(key);
	}
}

function emitTextStart(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): void {
	output.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex: 0, partial: output });
}

async function runTurn(
	key: string,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	await withTurnLock(key, async () => {
		let processState: AgyProcess | undefined;
		let output = makeAssistantMessage(model);
		let textStarted = false;
		let textEnded = false;
		let text = "";
		let responseSeen = false;
		const abort = () => {
			if (processState && !processState.closed) processState.child.kill("SIGTERM");
		};
		options?.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			processState = await ensureProcess(key, model, context, options);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			let payload: StreamInput = {
				event: "user",
				message: { role: "user", content: turnPrompt(processState, context) },
			};
			const replacement = await options?.onPayload?.(payload, model);
			if (replacement !== undefined) payload = replacement as StreamInput;
			const serialized = JSON.stringify(payload);
			if (!serialized) throw new Error("Could not serialize Antigravity stream input");
			await new Promise<void>((resolve, reject) => {
				processState!.child.stdin.write(`${serialized}\n`, (error) => (error ? reject(error) : resolve()));
			});
			stream.push({ type: "start", partial: output });

			while (true) {
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				const line = await processState.reader.next();
				if (line === null) {
					throw new Error(
						processState.stderr.trim() || "agy exited before returning a result",
					);
				}
				if (!line.trim()) continue;
				let event: AgyStreamEvent;
				try {
					event = JSON.parse(line) as AgyStreamEvent;
				} catch {
					continue;
				}
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				try {
					await options?.onProviderStreamEvent?.(event, model);
				} catch {
					// Observers are diagnostic hooks; they must not break generation.
				}
				if (!responseSeen) {
					responseSeen = true;
					try {
						// `agy` has no HTTP response object. Treat the first parsed
						// event of this request as the response boundary.
						await options?.onResponse?.({ status: 200, headers: {} }, model);
					} catch {
						// Match Pi's built-in adapters: response observers are best effort.
					}
				}

				if (event.event === "init") continue;

				const step = event.step_update;
				if (event.event === "step_update" && step?.step_type === "agent_response") {
					if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
						if (!textStarted) {
							textStarted = true;
							emitTextStart(stream, output);
						}
						text += step.text_delta;
						const block = output.content[0];
						if (block?.type === "text") block.text = text;
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: step.text_delta,
							partial: output,
						});
					}
					continue;
				}

				if (event.event !== "result" || !event.result) continue;
				const result = event.result;
				const resultText = typeof result.response === "string" ? result.response : "";
				if (resultText && !textStarted) {
					textStarted = true;
					emitTextStart(stream, output);
					text = resultText;
					const block = output.content[0];
					if (block?.type === "text") block.text = text;
					stream.push({ type: "text_delta", contentIndex: 0, delta: resultText, partial: output });
				} else if (resultText.length > text.length && resultText.startsWith(text)) {
					const suffix = resultText.slice(text.length);
					text += suffix;
					const block = output.content[0];
					if (block?.type === "text") block.text = text;
					stream.push({ type: "text_delta", contentIndex: 0, delta: suffix, partial: output });
				}
				if (textStarted && !textEnded) {
					textEnded = true;
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
				}

				const cumulative = parseUsage(result.usage);
				const delta = subtractUsage(cumulative, processState.cumulativeUsage);
				processState.cumulativeUsage = cumulative;
				output.usage = usageFromRaw(delta);
				processState.turns += 1;
				processState.contextMessageCount = nonSystemMessages(context).length;
				processState.systemSignature = systemSignature(context);

				if (result.status?.toUpperCase() === "SUCCESS") {
					output.stopReason = "stop";
					output.rawStopReason = result.status;
					stream.push({ type: "done", reason: "stop", message: output });
					stream.end(output);
					return;
				}
				throw new Error(result.error || processState.stderr.trim() || "Antigravity returned an error");
			}
		} catch (error) {
			const aborted = options?.signal?.aborted === true;
			if (textStarted && !textEnded) {
				textEnded = true;
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
			}
			if (processState) await destroyProcess(processState);
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted
				? "Request was aborted"
				: error instanceof Error
					? error.message
					: String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end(output);
		} finally {
			options?.signal?.removeEventListener("abort", abort);
		}
	});
}

async function closeAllProcesses(): Promise<void> {
	const active = [...processes.values()];
	await Promise.all(active.map((processState) => destroyProcess(processState)));
}

export default async function antigravityExtension(pi: ExtensionAPI): Promise<void> {
	const models = await discoverModels();
	pi.registerProvider(ANTIGRAVITY_PROVIDER, {
		name: "Antigravity CLI",
		baseUrl: "agy://local",
		// This is a local CLI provider. The literal keeps models visible even when
		// the CLI uses its own stored OAuth/keychain authentication.
		apiKey: "agy",
		api: ANTIGRAVITY_API,
		models,
		refreshModels: async (context) => discoverModels(context.signal),
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const key = options?.sessionId || "default";
			void runTurn(key, model, context, options, stream);
			return stream;
		},
	});

	pi.on("session_shutdown", async (_event: SessionShutdownEvent) => {
		await closeAllProcesses();
	});
}

// Keep this module usable from small Node-based smoke tests without making the
// provider's process registry part of the public API.
export const __testing = {
	parseModelOutput,
	modelConfig,
	parseUsage,
	subtractUsage,
};
