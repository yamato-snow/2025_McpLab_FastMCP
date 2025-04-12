/**
 * FastMCP - Model Context Protocol (MCP)のTypeScript実装
 * 
 * このファイルはMCPサーバーを実装するためのメインクラスとユーティリティを提供します。
 * MCPはAIアシスタントがローカルリソースやツールにアクセスするための標準プロトコルです。
 * 
 * 主な機能:
 * - ツール呼び出し（AIモデルがローカル関数を実行できる）
 * - リソースアクセス（AIモデルがファイルなどのリソースを読み取れる）
 * - プロンプトテンプレート（共通のプロンプトパターンを定義できる）
 * - セッション管理（複数クライアントとの接続を管理）
 * 
 * @see https://modelcontextprotocol.io/
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ClientCapabilities,
  CompleteRequestSchema,
  CreateMessageRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  Root,
  RootsListChangedNotificationSchema,
  ServerCapabilities,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
import { toJsonSchema } from "xsschema";
import { z } from "zod";
import { setTimeout as delay } from "timers/promises";
import { readFile } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { StrictEventEmitter } from "strict-event-emitter-types";
import { EventEmitter } from "events";
import Fuse from "fuse.js";
import { startSSEServer } from "mcp-proxy";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import parseURITemplate from "uri-templates";
import http from "http";
import {
  fetch
} from "undici";

export type SSEServer = {
  close: () => Promise<void>;
};

type FastMCPEvents<T extends FastMCPSessionAuth> = {
  connect: (event: { session: FastMCPSession<T> }) => void;
  disconnect: (event: { session: FastMCPSession<T> }) => void;
};

type FastMCPSessionEvents = {
  rootsChanged: (event: { roots: Root[] }) => void;
  error: (event: { error: Error }) => void;
};

/**
 * 画像コンテンツオブジェクトを生成するユーティリティ関数
 * URLやファイルパス、バッファからBase64エンコードされた画像データを作成します
 */
export const imageContent = async (
  input: { url: string } | { path: string } | { buffer: Buffer },
): Promise<ImageContent> => {
  let rawData: Buffer;

  if ("url" in input) {
    const response = await fetch(input.url);

    if (!response.ok) {
      throw new Error(`Failed to fetch image from URL: ${response.statusText}`);
    }

    rawData = Buffer.from(await response.arrayBuffer());
  } else if ("path" in input) {
    rawData = await readFile(input.path);
  } else if ("buffer" in input) {
    rawData = input.buffer;
  } else {
    throw new Error(
      "Invalid input: Provide a valid 'url', 'path', or 'buffer'",
    );
  }

  const mimeType = await fileTypeFromBuffer(rawData);

  const base64Data = rawData.toString("base64");

  return {
    type: "image",
    data: base64Data,
    mimeType: mimeType?.mime ?? "image/png",
  } as const;
};

/**
 * エラーの基底クラス
 * すべてのカスタムエラーはこのクラスを継承します
 */
abstract class FastMCPError extends Error {
  public constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

type Extra = unknown;

type Extras = Record<string, Extra>;

/**
 * 予期しない状態エラー
 * 内部的な問題が発生した場合に使用されます
 */
export class UnexpectedStateError extends FastMCPError {
  public extras?: Extras;

  public constructor(message: string, extras?: Extras) {
    super(message);
    this.name = new.target.name;
    this.extras = extras;
  }
}

/**
 * ユーザーに表示するためのエラー
 * 意図的にユーザーに伝えるべきエラーメッセージを定義します
 */
export class UserError extends UnexpectedStateError {}

type ToolParameters = StandardSchemaV1;

type Literal = boolean | null | number | string | undefined;

type SerializableValue =
  | Literal
  | SerializableValue[]
  | { [key: string]: SerializableValue };

type Progress = {
  /**
   * The progress thus far. This should increase every time progress is made, even if the total is unknown.
   */
  progress: number;
  /**
   * Total number of items to process (or total progress required), if known.
   */
  total?: number;
};

type Context<T extends FastMCPSessionAuth> = {
  session: T | undefined;
  reportProgress: (progress: Progress) => Promise<void>;
  log: {
    debug: (message: string, data?: SerializableValue) => void;
    error: (message: string, data?: SerializableValue) => void;
    info: (message: string, data?: SerializableValue) => void;
    warn: (message: string, data?: SerializableValue) => void;
  };
};

type TextContent = {
  type: "text";
  text: string;
};

const TextContentZodSchema = z
  .object({
    type: z.literal("text"),
    /**
     * The text content of the message.
     */
    text: z.string(),
  })
  .strict() satisfies z.ZodType<TextContent>;

type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

const ImageContentZodSchema = z
  .object({
    type: z.literal("image"),
    /**
     * The base64-encoded image data.
     */
    data: z.string().base64(),
    /**
     * The MIME type of the image. Different providers may support different image types.
     */
    mimeType: z.string(),
  })
  .strict() satisfies z.ZodType<ImageContent>;

type Content = TextContent | ImageContent;

const ContentZodSchema = z.discriminatedUnion("type", [
  TextContentZodSchema,
  ImageContentZodSchema,
]) satisfies z.ZodType<Content>;

type ContentResult = {
  content: Content[];
  isError?: boolean;
};

const ContentResultZodSchema = z
  .object({
    content: ContentZodSchema.array(),
    isError: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<ContentResult>;

type Completion = {
  values: string[];
  total?: number;
  hasMore?: boolean;
};

/**
 * https://github.com/modelcontextprotocol/typescript-sdk/blob/3164da64d085ec4e022ae881329eee7b72f208d4/src/types.ts#L983-L1003
 */
const CompletionZodSchema = z.object({
  /**
   * An array of completion values. Must not exceed 100 items.
   */
  values: z.array(z.string()).max(100),
  /**
   * The total number of completion options available. This can exceed the number of values actually sent in the response.
   */
  total: z.optional(z.number().int()),
  /**
   * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
   */
  hasMore: z.optional(z.boolean()),
}) satisfies z.ZodType<Completion>;

type Tool<T extends FastMCPSessionAuth, Params extends ToolParameters = ToolParameters> = {
  name: string;
  description?: string;
  parameters?: Params;
  execute: (
    args: StandardSchemaV1.InferOutput<Params>,
    context: Context<T>,
  ) => Promise<string | ContentResult | TextContent | ImageContent>;
};

type ResourceResult =
  | {
      text: string;
    }
  | {
      blob: string;
    };

type InputResourceTemplateArgument = Readonly<{
  name: string;
  description?: string;
  complete?: ArgumentValueCompleter;
}>;

type ResourceTemplateArgument = Readonly<{
  name: string;
  description?: string;
  complete?: ArgumentValueCompleter;
}>;

type ResourceTemplate<
  Arguments extends ResourceTemplateArgument[] = ResourceTemplateArgument[],
> = {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  arguments: Arguments;
  complete?: (name: string, value: string) => Promise<Completion>;
  load: (
    args: ResourceTemplateArgumentsToObject<Arguments>,
  ) => Promise<ResourceResult>;
};

type ResourceTemplateArgumentsToObject<T extends { name: string }[]> = {
  [K in T[number]["name"]]: string;
};

type InputResourceTemplate<
  Arguments extends ResourceTemplateArgument[] = ResourceTemplateArgument[],
> = {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  arguments: Arguments;
  load: (
    args: ResourceTemplateArgumentsToObject<Arguments>,
  ) => Promise<ResourceResult>;
};

type Resource = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  load: () => Promise<ResourceResult | ResourceResult[]>;
  complete?: (name: string, value: string) => Promise<Completion>;
};

type ArgumentValueCompleter = (value: string) => Promise<Completion>;

type InputPromptArgument = Readonly<{
  name: string;
  description?: string;
  required?: boolean;
  complete?: ArgumentValueCompleter;
  enum?: string[];
}>;

type PromptArgumentsToObject<T extends { name: string; required?: boolean }[]> =
  {
    [K in T[number]["name"]]: Extract<
      T[number],
      { name: K }
    >["required"] extends true
      ? string
      : string | undefined;
  };

type InputPrompt<
  Arguments extends InputPromptArgument[] = InputPromptArgument[],
  Args = PromptArgumentsToObject<Arguments>,
> = {
  name: string;
  description?: string;
  arguments?: InputPromptArgument[];
  load: (args: Args) => Promise<string>;
};

type PromptArgument = Readonly<{
  name: string;
  description?: string;
  required?: boolean;
  complete?: ArgumentValueCompleter;
  enum?: string[];
}>;

type Prompt<
  Arguments extends PromptArgument[] = PromptArgument[],
  Args = PromptArgumentsToObject<Arguments>,
> = {
  arguments?: PromptArgument[];
  complete?: (name: string, value: string) => Promise<Completion>;
  description?: string;
  load: (args: Args) => Promise<string>;
  name: string;
};

type ServerOptions<T extends FastMCPSessionAuth> = {
  name: string;
  version: `${number}.${number}.${number}`;
  authenticate?: Authenticate<T>;
};

type LoggingLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

const FastMCPSessionEventEmitterBase: {
  new (): StrictEventEmitter<EventEmitter, FastMCPSessionEvents>;
} = EventEmitter;

class FastMCPSessionEventEmitter extends FastMCPSessionEventEmitterBase {}

type SamplingResponse = {
  model: string;
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | string;
  role: "user" | "assistant";
  content: TextContent | ImageContent | { type: "audio"; data: string; mimeType: string };
};

type FastMCPSessionAuth = Record<string, unknown> | undefined;

/**
 * MCPセッションクラス
 * クライアントとのセッションを管理し、ツール、リソース、プロンプトの要求を処理します
 */
export class FastMCPSession<T extends FastMCPSessionAuth = FastMCPSessionAuth> extends FastMCPSessionEventEmitter {
  #capabilities: ServerCapabilities = {};
  #clientCapabilities?: ClientCapabilities;
  #loggingLevel: LoggingLevel = "info";
  #prompts: Prompt[] = [];
  #resources: Resource[] = [];
  #resourceTemplates: ResourceTemplate[] = [];
  #roots: Root[] = [];
  #server: Server;
  #auth: T | undefined;

  constructor({
    auth,
    name,
    version,
    tools,
    resources,
    resourcesTemplates,
    prompts,
  }: {
    auth?: T;
    name: string;
    version: string;
    tools: Tool<T>[];
    resources: Resource[];
    resourcesTemplates: InputResourceTemplate[];
    prompts: Prompt[];
  }) {
    super();

    this.#auth = auth;

    if (tools.length) {
      this.#capabilities.tools = {};
    }

    if (resources.length || resourcesTemplates.length) {
      this.#capabilities.resources = {};
    }

    if (prompts.length) {
      for (const prompt of prompts) {
        this.addPrompt(prompt);
      }

      this.#capabilities.prompts = {};
    }

    this.#capabilities.logging = {};

    this.#server = new Server(
      { name: name, version: version },
      { capabilities: this.#capabilities },
    );

    this.setupErrorHandling();
    this.setupLoggingHandlers();
    this.setupRootsHandlers();
    this.setupCompleteHandlers();

    if (tools.length) {
      this.setupToolHandlers(tools);
    }

    if (resources.length || resourcesTemplates.length) {
      for (const resource of resources) {
        this.addResource(resource);
      }

      this.setupResourceHandlers(resources);

      if (resourcesTemplates.length) {
        for (const resourceTemplate of resourcesTemplates) {
          this.addResourceTemplate(resourceTemplate);
        }

        this.setupResourceTemplateHandlers(resourcesTemplates);
      }
    }

    if (prompts.length) {
      this.setupPromptHandlers(prompts);
    }
  }

  /**
   * リソースをセッションに追加します
   * @param inputResource 追加するリソース
   */
  private addResource(inputResource: Resource) {
    this.#resources.push(inputResource);
  }

  /**
   * リソーステンプレートをセッションに追加します
   * @param inputResourceTemplate 追加するリソーステンプレート
   */
  private addResourceTemplate(inputResourceTemplate: InputResourceTemplate) {
    const completers: Record<string, ArgumentValueCompleter> = {};

    for (const argument of inputResourceTemplate.arguments ?? []) {
      if (argument.complete) {
        completers[argument.name] = argument.complete;
      }
    }

    const resourceTemplate = {
      ...inputResourceTemplate,
      complete: async (name: string, value: string) => {
        if (completers[name]) {
          return await completers[name](value);
        }

        return {
          values: [],
        };
      },
    };

    this.#resourceTemplates.push(resourceTemplate);
  }

  /**
   * プロンプトをセッションに追加します
   * @param inputPrompt 追加するプロンプト
   */
  private addPrompt(inputPrompt: InputPrompt) {
    const completers: Record<string, ArgumentValueCompleter> = {};
    const enums: Record<string, string[]> = {};

    for (const argument of inputPrompt.arguments ?? []) {
      if (argument.complete) {
        completers[argument.name] = argument.complete;
      }

      if (argument.enum) {
        enums[argument.name] = argument.enum;
      }
    }

    const prompt = {
      ...inputPrompt,
      complete: async (name: string, value: string) => {
        if (completers[name]) {
          return await completers[name](value);
        }

        if (enums[name]) {
          const fuse = new Fuse(enums[name], {
            keys: ["value"],
          });

          const result = fuse.search(value);

          return {
            values: result.map((item) => item.item),
            total: result.length,
          };
        }

        return {
          values: [],
        };
      },
    };

    this.#prompts.push(prompt);
  }

  public get clientCapabilities(): ClientCapabilities | null {
    return this.#clientCapabilities ?? null;
  }

  public get server(): Server {
    return this.#server;
  }

  #pingInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * AIモデルに対してサンプリング要求を送信します
   * LLMから回答を生成するために使用します
   */
  public async requestSampling(
    message: z.infer<typeof CreateMessageRequestSchema>["params"],
  ): Promise<SamplingResponse> {
    return this.#server.createMessage(message);
  }

  /**
   * トランスポートを使用してサーバーに接続します
   * @param transport 使用するトランスポート（StdioやSSEなど）
   */
  public async connect(transport: Transport) {
    if (this.#server.transport) {
      throw new UnexpectedStateError("Server is already connected");
    }

    await this.#server.connect(transport);

    let attempt = 0;

    while (attempt++ < 10) {
      const capabilities = await this.#server.getClientCapabilities();

      if (capabilities) {
        this.#clientCapabilities = capabilities;

        break;
      }

      await delay(100);
    }

    if (!this.#clientCapabilities) {
      console.warn('[warning] FastMCP could not infer client capabilities')
    }

    if (this.#clientCapabilities?.roots?.listChanged) {
      try {
        const roots = await this.#server.listRoots();
        this.#roots = roots.roots;
      } catch(e) {
        console.error(`[error] FastMCP received error listing roots.\n\n${e instanceof Error ? e.stack : JSON.stringify(e)}`)
      }
    }

    this.#pingInterval = setInterval(async () => {
      try {
        await this.#server.ping();
      } catch (error) {
        this.emit("error", {
          error: error as Error,
        });
      }
    }, 1000);
  }

  public get roots(): Root[] {
    return this.#roots;
  }

  public async close() {
    if (this.#pingInterval) {
      clearInterval(this.#pingInterval);
    }

    try {
      await this.#server.close();
    } catch (error) {
      console.error("[MCP Error]", "could not close server", error);
    }
  }

  private setupErrorHandling() {
    this.#server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };
  }

  public get loggingLevel(): LoggingLevel {
    return this.#loggingLevel;
  }

  private setupCompleteHandlers() {
    this.#server.setRequestHandler(CompleteRequestSchema, async (request) => {
      if (request.params.ref.type === "ref/prompt") {
        const prompt = this.#prompts.find(
          (prompt) => prompt.name === request.params.ref.name,
        );

        if (!prompt) {
          throw new UnexpectedStateError("Unknown prompt", {
            request,
          });
        }

        if (!prompt.complete) {
          throw new UnexpectedStateError("Prompt does not support completion", {
            request,
          });
        }

        const completion = CompletionZodSchema.parse(
          await prompt.complete(
            request.params.argument.name,
            request.params.argument.value,
          ),
        );

        return {
          completion,
        };
      }

      if (request.params.ref.type === "ref/resource") {
        const resource = this.#resourceTemplates.find(
          (resource) => resource.uriTemplate === request.params.ref.uri,
        );

        if (!resource) {
          throw new UnexpectedStateError("Unknown resource", {
            request,
          });
        }

        if (!("uriTemplate" in resource)) {
          throw new UnexpectedStateError("Unexpected resource");
        }

        if (!resource.complete) {
          throw new UnexpectedStateError(
            "Resource does not support completion",
            {
              request,
            },
          );
        }

        const completion = CompletionZodSchema.parse(
          await resource.complete(
            request.params.argument.name,
            request.params.argument.value,
          ),
        );

        return {
          completion,
        };
      }

      throw new UnexpectedStateError("Unexpected completion request", {
        request,
      });
    });
  }

  private setupRootsHandlers() {
    this.#server.setNotificationHandler(
      RootsListChangedNotificationSchema,
      () => {
        this.#server.listRoots().then((roots) => {
          this.#roots = roots.roots;

          this.emit("rootsChanged", {
            roots: roots.roots,
          });
        });
      },
    );
  }

  private setupLoggingHandlers() {
    this.#server.setRequestHandler(SetLevelRequestSchema, (request) => {
      this.#loggingLevel = request.params.level;

      return {};
    });
  }

  private setupToolHandlers(tools: Tool<T>[]) {
    this.#server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: await Promise.all(tools.map(async (tool) => {
          return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters
              ? await toJsonSchema(tool.parameters)
              : undefined,
          };
        })),
      };
    });

    this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = tools.find((tool) => tool.name === request.params.name);

      if (!tool) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`,
        );
      }

      let args: any = undefined;

      if (tool.parameters) {
        const parsed = await tool.parameters["~standard"].validate(
          request.params.arguments
        );

        if (parsed.issues) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid ${request.params.name} parameters`,
          );
        }

        args = parsed.value;
      }

      const progressToken = request.params?._meta?.progressToken;

      let result: ContentResult;

      try {
        const reportProgress = async (progress: Progress) => {
          await this.#server.notification({
            method: "notifications/progress",
            params: {
              ...progress,
              progressToken,
            },
          });
        };

        const log = {
          debug: (message: string, context?: SerializableValue) => {
            this.#server.sendLoggingMessage({
              level: "debug",
              data: {
                message,
                context,
              },
            });
          },
          error: (message: string, context?: SerializableValue) => {
            this.#server.sendLoggingMessage({
              level: "error",
              data: {
                message,
                context,
              },
            });
          },
          info: (message: string, context?: SerializableValue) => {
            this.#server.sendLoggingMessage({
              level: "info",
              data: {
                message,
                context,
              },
            });
          },
          warn: (message: string, context?: SerializableValue) => {
            this.#server.sendLoggingMessage({
              level: "warning",
              data: {
                message,
                context,
              },
            });
          },
        };

        const maybeStringResult = await tool.execute(args, {
          reportProgress,
          log,
          session: this.#auth,
        });

        if (typeof maybeStringResult === "string") {
          result = ContentResultZodSchema.parse({
            content: [{ type: "text", text: maybeStringResult }],
          });
        } else if ("type" in maybeStringResult) {
          result = ContentResultZodSchema.parse({
            content: [maybeStringResult],
          });
        } else {
          result = ContentResultZodSchema.parse(maybeStringResult);
        }
      } catch (error) {
        if (error instanceof UserError) {
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Error: ${error}` }],
          isError: true,
        };
      }

      return result;
    });
  }

  private setupResourceHandlers(resources: Resource[]) {
    this.#server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: resources.map((resource) => {
          return {
            uri: resource.uri,
            name: resource.name,
            mimeType: resource.mimeType,
          };
        }),
      };
    });

    this.#server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        if ("uri" in request.params) {
          const resource = resources.find(
            (resource) =>
              "uri" in resource && resource.uri === request.params.uri,
          );

          if (!resource) {
            for (const resourceTemplate of this.#resourceTemplates) {
              const uriTemplate = parseURITemplate(
                resourceTemplate.uriTemplate,
              );

              const match = uriTemplate.fromUri(request.params.uri);

              if (!match) {
                continue;
              }

              const uri = uriTemplate.fill(match);

              const result = await resourceTemplate.load(match);

              return {
                contents: [
                  {
                    uri: uri,
                    mimeType: resourceTemplate.mimeType,
                    name: resourceTemplate.name,
                    ...result,
                  },
                ],
              };
            }

            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown resource: ${request.params.uri}`,
            );
          }

          if (!("uri" in resource)) {
            throw new UnexpectedStateError("Resource does not support reading");
          }

          let maybeArrayResult: Awaited<ReturnType<Resource["load"]>>;

          try {
            maybeArrayResult = await resource.load();
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Error reading resource: ${error}`,
              {
                uri: resource.uri,
              },
            );
          }

          if (Array.isArray(maybeArrayResult)) {
            return {
              contents: maybeArrayResult.map((result) => ({
                uri: resource.uri,
                mimeType: resource.mimeType,
                name: resource.name,
                ...result,
              })),
            };
          } else {
            return {
              contents: [
                {
                  uri: resource.uri,
                  mimeType: resource.mimeType,
                  name: resource.name,
                  ...maybeArrayResult,
                },
              ],
            };
          }
        }

        throw new UnexpectedStateError("Unknown resource request", {
          request,
        });
      },
    );
  }

  private setupResourceTemplateHandlers(resourceTemplates: ResourceTemplate[]) {
    this.#server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => {
        return {
          resourceTemplates: resourceTemplates.map((resourceTemplate) => {
            return {
              name: resourceTemplate.name,
              uriTemplate: resourceTemplate.uriTemplate,
            };
          }),
        };
      },
    );
  }

  private setupPromptHandlers(prompts: Prompt[]) {
    this.#server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: prompts.map((prompt) => {
          return {
            name: prompt.name,
            description: prompt.description,
            arguments: prompt.arguments,
            complete: prompt.complete,
          };
        }),
      };
    });

    this.#server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = prompts.find(
        (prompt) => prompt.name === request.params.name,
      );

      if (!prompt) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown prompt: ${request.params.name}`,
        );
      }

      const args = request.params.arguments;

      for (const arg of prompt.arguments ?? []) {
        if (arg.required && !(args && arg.name in args)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Missing required argument: ${arg.name}`,
          );
        }
      }

      let result: Awaited<ReturnType<Prompt["load"]>>;

      try {
        result = await prompt.load(args as Record<string, string | undefined>);
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Error loading prompt: ${error}`,
        );
      }

      return {
        description: prompt.description,
        messages: [
          {
            role: "user",
            content: { type: "text", text: result },
          },
        ],
      };
    });
  }
}

const FastMCPEventEmitterBase: {
  new (): StrictEventEmitter<EventEmitter, FastMCPEvents<FastMCPSessionAuth>>;
} = EventEmitter;

class FastMCPEventEmitter extends FastMCPEventEmitterBase {}

type Authenticate<T> = (request: http.IncomingMessage) => Promise<T>;

/**
 * FastMCPメインクラス
 * MCP機能を提供するサーバーを構築するためのメインエントリーポイント
 */
export class FastMCP<T extends Record<string, unknown> | undefined = undefined> extends FastMCPEventEmitter {
  #options: ServerOptions<T>;
  #prompts: InputPrompt[] = [];
  #resources: Resource[] = [];
  #resourcesTemplates: InputResourceTemplate[] = [];
  #sessions: FastMCPSession<T>[] = [];
  #sseServer: SSEServer | null = null;
  #tools: Tool<T>[] = [];
  #authenticate: Authenticate<T> | undefined;

  constructor(public options: ServerOptions<T>) {
    super();

    this.#options = options;
    this.#authenticate = options.authenticate;
  }

  public get sessions(): FastMCPSession<T>[] {
    return this.#sessions;
  }

  /**
   * ツールをサーバーに追加します
   * AIモデルが呼び出し可能な関数を定義します
   */
  public addTool<Params extends ToolParameters>(tool: Tool<T, Params>) {
    this.#tools.push(tool as unknown as Tool<T>);
  }

  /**
   * リソースをサーバーに追加します
   * AIモデルが読み取り可能なデータを定義します
   */
  public addResource(resource: Resource) {
    this.#resources.push(resource);
  }

  /**
   * リソーステンプレートをサーバーに追加します
   * パラメータ化されたリソースをAIモデルに提供します
   */
  public addResourceTemplate<
    const Args extends InputResourceTemplateArgument[],
  >(resource: InputResourceTemplate<Args>) {
    this.#resourcesTemplates.push(resource);
  }

  /**
   * プロンプトをサーバーに追加します
   * 再利用可能なプロンプトテンプレートを定義します
   */
  public addPrompt<const Args extends InputPromptArgument[]>(
    prompt: InputPrompt<Args>,
  ) {
    this.#prompts.push(prompt);
  }

  /**
   * サーバーを起動します
   * 指定されたトランスポート（stdio、SSE）でMCPサーバーを開始します
   */
  public async start(
    options:
      | { transportType: "stdio" }
      | {
          transportType: "sse";
          sse: { endpoint: `/${string}`; port: number };
        } = {
      transportType: "stdio",
    },
  ) {
    if (options.transportType === "stdio") {
      const transport = new StdioServerTransport();

      const session = new FastMCPSession<T>({
        name: this.#options.name,
        version: this.#options.version,
        tools: this.#tools,
        resources: this.#resources,
        resourcesTemplates: this.#resourcesTemplates,
        prompts: this.#prompts,
      });

      await session.connect(transport);

      this.#sessions.push(session);

      this.emit("connect", {
        session,
      });

    } else if (options.transportType === "sse") {
      this.#sseServer = await startSSEServer<FastMCPSession<T>>({
        endpoint: options.sse.endpoint as `/${string}`,
        port: options.sse.port,
        createServer: async (request) => {
          let auth: T | undefined;

          if (this.#authenticate) {
            auth = await this.#authenticate(request);
          }

          return new FastMCPSession<T>({
            auth,
            name: this.#options.name,
            version: this.#options.version,
            tools: this.#tools,
            resources: this.#resources,
            resourcesTemplates: this.#resourcesTemplates,
            prompts: this.#prompts,
          });
        },
        onClose: (session) => {
          this.emit("disconnect", {
            session,
          });
        },
        onConnect: async (session) => {
          this.#sessions.push(session);

          this.emit("connect", {
            session,
          });
        },
      });

      console.info(
        `server is running on SSE at http://localhost:${options.sse.port}${options.sse.endpoint}`,
      );
    } else {
      throw new Error("Invalid transport type");
    }
  }

  /**
   * サーバーを停止します
   * アクティブなセッションをクリーンアップします
   */
  public async stop() {
    if (this.#sseServer) {
      this.#sseServer.close();
    }
  }
}

export type { Context };
export type { Tool, ToolParameters };
export type { Content, TextContent, ImageContent, ContentResult };
export type { Progress, SerializableValue };
export type { Resource, ResourceResult };
export type { ResourceTemplate, ResourceTemplateArgument };
export type { Prompt, PromptArgument };
export type { InputPrompt, InputPromptArgument };
export type { ServerOptions, LoggingLevel };
export type { FastMCPEvents, FastMCPSessionEvents };
