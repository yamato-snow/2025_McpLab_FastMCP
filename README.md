# FastMCP

FastMCPは、クライアントセッション管理が可能な[MCP](https://glama.ai/mcp)サーバーを構築するためのTypeScriptフレームワークです。

> [!NOTE]
>
> Python実装版は[FastMCP Python](https://github.com/jlowin/fastmcp)をご覧ください。

## 主な機能

FastMCPは以下の機能を提供します：

- シンプルなツール、リソース、プロンプト定義
- [認証機能](#認証)
- [セッション管理](#セッション)
- [画像コンテンツ対応](#画像の返却)
- [ロギング](#ロギング)
- [エラーハンドリング](#エラー)
- [SSE(Server-Sent Events)](#sse)
- CORS（デフォルトで有効）
- [進捗通知](#進捗通知)
- [型付きサーバーイベント](#型付きサーバーイベント)
- [プロンプト引数の自動補完](#プロンプト引数の自動補完)
- [サンプリングリクエスト](#サンプリングリクエスト)
- 自動SSEピング
- ルート管理
- [テスト](#mcp-cliでテスト)や[デバッグ](#mcp-inspectorで検査)のためのCLI

## インストール方法

```bash
npm install fastmcp
```

## クイックスタート

> [!NOTE]
>
> FastMCPの実際の使用例は多数あります。[事例紹介](#事例紹介)をご覧ください。

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod"; // または他の検証ライブラリ（Standard Schemaをサポートしているもの）

const server = new FastMCP({
  name: "マイサーバー",
  version: "1.0.0",
});

server.addTool({
  name: "add",
  description: "2つの数値を足し算します",
  parameters: z.object({
    a: z.number(),
    b: z.number(),
  }),
  execute: async (args) => {
    return String(args.a + args.b);
  },
});

server.start({
  transportType: "stdio",
});
```

これだけで動作するMCPサーバーができました！

ターミナルで以下のようにテストできます：

```bash
git clone https://github.com/punkpeye/fastmcp.git
cd fastmcp

pnpm install
pnpm build

# CLIを使った足し算サーバーの例をテスト：
npx fastmcp dev src/examples/addition.ts
# MCP Inspectorを使った足し算サーバーの例を検査：
npx fastmcp inspect src/examples/addition.ts
```

### SSE

[Server-Sent Events](https://developer.mozilla.org/ja/docs/Web/API/Server-sent_events)（SSE）は、サーバーがHTTPS接続を介してクライアントにリアルタイム更新を送信するメカニズムです。MCPにおいて、SSEは主にリモートMCP通信を可能にするために使用され、リモートマシンでホストされたMCPにアクセスしてネットワーク経由で更新を中継できるようにします。

SSEサポート付きでサーバーを実行することもできます：

```ts
server.start({
  transportType: "sse",
  sse: {
    endpoint: "/sse",
    port: 8080,
  },
});
```

これにより、サーバーが起動し、`http://localhost:8080/sse`でSSE接続をリッスンします。

その後、`SSEClientTransport`を使用してサーバーに接続できます：

```ts
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0",
  },
  {
    capabilities: {},
  },
);

const transport = new SSEClientTransport(new URL(`http://localhost:8080/sse`));

await client.connect(transport);
```

## 基本概念

### ツール

MCPの[ツール](https://modelcontextprotocol.io/docs/concepts/tools)では、サーバーが実行可能な関数を公開し、クライアントやLLMがアクションを実行するために呼び出すことができます。

FastMCPはツールパラメーターの定義に[Standard Schema](https://standardschema.dev)仕様を使用しています。これにより、Zod、ArkType、Valibotなど、仕様を実装している好みのスキーマ検証ライブラリを使用できます。

**Zodの例：**

```typescript
import { z } from "zod";

server.addTool({
  name: "fetch-zod",
  description: "URLのコンテンツを取得します（Zodを使用）",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return await fetchWebpageContent(args.url);
  },
});
```

**ArkTypeの例：**

```typescript
import { type } from "arktype";

server.addTool({
  name: "fetch-arktype",
  description: "URLのコンテンツを取得します（ArkTypeを使用）",
  parameters: type({
    url: "string",
  }),
  execute: async (args) => {
    return await fetchWebpageContent(args.url);
  },
});
```

**Valibotの例：**

Valibotにはピア依存関係@valibot/to-json-schemaが必要です。

```typescript
import * as v from "valibot";

server.addTool({
  name: "fetch-valibot",
  description: "URLのコンテンツを取得します（Valibotを使用）",
  parameters: v.object({
    url: v.string(),
  }),
  execute: async (args) => {
    return await fetchWebpageContent(args.url);
  },
});
```

#### 文字列を返す

`execute`は文字列を返すことができます：

```js
server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return "こんにちは、世界！";
  },
});
```

これは以下と同等です：

```js
server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "text",
          text: "こんにちは、世界！",
        },
      ],
    };
  },
});
```

#### リストを返す

メッセージのリストを返したい場合は、`content`プロパティを持つオブジェクトを返せます：

```js
server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        { type: "text", text: "1つ目のメッセージ" },
        { type: "text", text: "2つ目のメッセージ" },
      ],
    };
  },
});
```

#### 画像の返却

画像のコンテンツオブジェクトを作成するには、`imageContent`を使用します：

```js
import { imageContent } from "fastmcp";

server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return imageContent({
      url: "https://example.com/image.png",
    });

    // または...
    // return imageContent({
    //   path: "/path/to/image.png",
    // });

    // または...
    // return imageContent({
    //   buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
    // });

    // または...
    // return {
    //   content: [
    //     await imageContent(...)
    //   ],
    // };
  },
});
```

`imageContent`関数は以下のオプションを受け取ります：

- `url`: 画像のURL
- `path`: 画像ファイルへのパス
- `buffer`: バッファとしての画像データ

`url`、`path`、`buffer`のいずれか1つのみを指定する必要があります。

上の例は以下と同等です：

```js
server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          mimeType: "image/png",
        },
      ],
    };
  },
});
```

#### ロギング

ツールはコンテキストオブジェクトの`log`を使用してクライアントにメッセージをログ出力できます：

```js
server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args, { log }) => {
    log.info("ファイルをダウンロード中...", {
      url: args.url,
    });

    // ...

    log.info("ファイルをダウンロードしました");

    return "完了";
  },
});
```

`log`オブジェクトには以下のメソッドがあります：

- `debug(message: string, data?: SerializableValue)`
- `error(message: string, data?: SerializableValue)`
- `info(message: string, data?: SerializableValue)`
- `warn(message: string, data?: SerializableValue)`

#### エラー

ユーザーに表示されるべきエラーは、`UserError`インスタンスとしてスローする必要があります：

```js
import { UserError } from "fastmcp";

server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    if (args.url.startsWith("https://example.com")) {
      throw new UserError("このURLは許可されていません");
    }

    return "完了";
  },
});
```

#### 進捗通知

ツールはコンテキストオブジェクトの`reportProgress`を呼び出すことで進捗を報告できます：

```js
server.addTool({
  name: "download",
  description: "ファイルをダウンロードします",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args, { reportProgress }) => {
    reportProgress({
      progress: 0,
      total: 100,
    });

    // ...

    reportProgress({
      progress: 100,
      total: 100,
    });

    return "完了";
  },
});
```

### リソース

[リソース](https://modelcontextprotocol.io/docs/concepts/resources)は、MCPサーバーがクライアントに提供したいあらゆる種類のデータを表します。これには以下が含まれます：

- ファイルの内容
- スクリーンショットや画像
- ログファイル
- その他多数

各リソースは一意のURIで識別され、テキストまたはバイナリデータを含むことができます。

```ts
server.addResource({
  uri: "file:///logs/app.log",
  name: "アプリケーションログ",
  mimeType: "text/plain",
  async load() {
    return {
      text: await readLogFile(),
    };
  },
});
```

> [!NOTE]
>
> `load`は複数のリソースを返すことができます。これは例えば、ディレクトリが読み込まれたときにディレクトリ内のファイルのリストを返すために使用できます。
>
> ```ts
> async load() {
>   return [
>     {
>       text: "1つ目のファイルの内容",
>     },
>     {
>       text: "2つ目のファイルの内容",
>     },
>   ];
> }
> ```

`load`でバイナリコンテンツを返すこともできます：

```ts
async load() {
  return {
    blob: 'base64でエンコードされたデータ'
  };
}
```

### リソーステンプレート

リソーステンプレートを定義することもできます：

```ts
server.addResourceTemplate({
  uriTemplate: "file:///logs/{name}.log",
  name: "アプリケーションログ",
  mimeType: "text/plain",
  arguments: [
    {
      name: "name",
      description: "ログの名前",
      required: true,
    },
  ],
  async load({ name }) {
    return {
      text: `${name}のサンプルログ内容`,
    };
  },
});
```

#### リソーステンプレート引数の自動補完

リソーステンプレート引数の自動補完を有効にするために、`complete`関数を提供します：

```ts
server.addResourceTemplate({
  uriTemplate: "file:///logs/{name}.log",
  name: "アプリケーションログ",
  mimeType: "text/plain",
  arguments: [
    {
      name: "name",
      description: "ログの名前",
      required: true,
      complete: async (value) => {
        if (value === "サンプル") {
          return {
            values: ["サンプルログ"],
          };
        }

        return {
          values: [],
        };
      },
    },
  ],
  async load({ name }) {
    return {
      text: `${name}のサンプルログ内容`,
    };
  },
});
```

### プロンプト

[プロンプト](https://modelcontextprotocol.io/docs/concepts/prompts)は、サーバーが再利用可能なプロンプトテンプレートとワークフローを定義し、クライアントがユーザーやLLMに簡単に提示できるようにします。これにより、一般的なLLMインタラクションを標準化して共有するための強力な方法を提供します。

```ts
server.addPrompt({
  name: "git-commit",
  description: "Gitコミットメッセージを生成します",
  arguments: [
    {
      name: "changes",
      description: "Gitの差分または変更の説明",
      required: true,
    },
  ],
  load: async (args) => {
    return `これらの変更に対する簡潔かつ説明的なコミットメッセージを生成してください：\n\n${args.changes}`;
  },
});
```

#### プロンプト引数の自動補完

プロンプトは引数の自動補完を提供できます：

```js
server.addPrompt({
  name: "countryPoem",
  description: "国についての詩を書きます",
  load: async ({ name }) => {
    return `こんにちは、${name}さん！`;
  },
  arguments: [
    {
      name: "name",
      description: "国の名前",
      required: true,
      complete: async (value) => {
        if (value === "日") {
          return {
            values: ["日本"],
          };
        }

        return {
          values: [],
        };
      },
    },
  ],
});
```

#### `enum`を使用したプロンプト引数の自動補完

引数に`enum`配列を提供すると、サーバーは自動的に引数の補完を提供します。

```js
server.addPrompt({
  name: "countryPoem",
  description: "国についての詩を書きます",
  load: async ({ name }) => {
    return `こんにちは、${name}さん！`;
  },
  arguments: [
    {
      name: "name",
      description: "国の名前",
      required: true,
      enum: ["日本", "フランス", "イタリア"],
    },
  ],
});
```

### 認証

FastMCPではカスタム関数を使用してクライアントを`authenticate`できます：

```ts
import { AuthError } from "fastmcp";

const server = new FastMCP({
  name: "マイサーバー",
  version: "1.0.0",
  authenticate: ({request}) => {
    const apiKey = request.headers["x-api-key"];

    if (apiKey !== '123') {
      throw new Response(null, {
        status: 401,
        statusText: "Unauthorized",
      });
    }

    // ここで返すものは`context.session`オブジェクトでアクセスできます
    return {
      id: 1,
    }
  },
});
```

これで、ツール内で認証されたセッションデータにアクセスできます：

```ts
server.addTool({
  name: "sayHello",
  execute: async (args, { session }) => {
    return `こんにちは、${session.id}さん！`;
  },
});
```

### セッション

`session`オブジェクトは`FastMCPSession`のインスタンスであり、アクティブなクライアントセッションを記述します。

```ts
server.sessions;
```

クライアントとサーバー間の1対1通信を可能にするために、各クライアント接続に対して新しいサーバーインスタンスを割り当てます。

### 型付きサーバーイベント

`on`メソッドを使用してサーバーから発行されるイベントをリッスンできます：

```ts
server.on("connect", (event) => {
  console.log("クライアント接続:", event.session);
});

server.on("disconnect", (event) => {
  console.log("クライアント切断:", event.session);
});
```

## `FastMCPSession`

`FastMCPSession`はクライアントセッションを表し、クライアントとやり取りするためのメソッドを提供します。

`FastMCPSession`インスタンスの取得方法については、[セッション](#セッション)の例を参照してください。

### `requestSampling`

`requestSampling`は[サンプリング](https://modelcontextprotocol.io/docs/concepts/sampling)リクエストを作成し、レスポンスを返します。

```ts
await session.requestSampling({
  messages: [
    {
      role: "user",
      content: {
        type: "text",
        text: "現在のディレクトリにはどのファイルがありますか？",
      },
    },
  ],
  systemPrompt: "あなたは役立つファイルシステムアシスタントです。",
  includeContext: "thisServer",
  maxTokens: 100,
});
```

### `clientCapabilities`

`clientCapabilities`プロパティにはクライアント機能が含まれています。

```ts
session.clientCapabilities;
```

### `loggingLevel`

`loggingLevel`プロパティは、クライアントによって設定されたロギングレベルを記述します。

```ts
session.loggingLevel;
```

### `roots`

`roots`プロパティには、クライアントによって設定されたルートが含まれています。

```ts
session.roots;
```

### `server`

`server`プロパティには、セッションに関連付けられたMCPサーバーのインスタンスが含まれています。

```ts
session.server;
```

### 型付きセッションイベント

`on`メソッドを使用してセッションから発行されるイベントをリッスンできます：

```ts
session.on("rootsChanged", (event) => {
  console.log("ルート変更:", event.roots);
});

session.on("error", (event) => {
  console.error("エラー:", event.error);
});
```

## サーバーの実行

### MCP-CLIでテスト

サーバーをテストしてデバッグする最速の方法は、`fastmcp dev`を使用することです：

```bash
npx fastmcp dev server.js
npx fastmcp dev server.ts
```

これにより、[`mcp-cli`](https://github.com/wong2/mcp-cli)を使用してターミナルでMCPサーバーをテストおよびデバッグするためのサーバーが実行されます。

### MCP Inspectorで検査

もう一つの方法は、公式の[`MCP Inspector`](https://modelcontextprotocol.io/docs/tools/inspector)を使用してWebUIでサーバーを検査することです：

```bash
npx fastmcp inspect server.ts
```

## よくある質問

### Claude Desktopで使用するには？

ガイド https://modelcontextprotocol.io/quickstart/user に従って、次の設定を追加してください：

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "npx",
      "args": [
        "tsx",
        "/プロジェクトへのパス/src/index.ts"
      ],
      "env": {
        "環境変数名": "値"
      }
    }
  }
}
```

## 事例紹介

> [!NOTE]
>
> FastMCPを使用したサーバーを開発した場合は、ぜひ[PR提出](https://github.com/punkpeye/fastmcp)して事例として紹介してください！

- [apinetwork/piapi-mcp-server](https://github.com/apinetwork/piapi-mcp-server) - Midjourney/Flux/Kling/LumaLabs/Udio/Chrip/Trellisを使用してメディアを生成
- [domdomegg/computer-use-mcp](https://github.com/domdomegg/computer-use-mcp) - コンピュータを制御
- [LiterallyBlah/Dradis-MCP](https://github.com/LiterallyBlah/Dradis-MCP) – Dradisでプロジェクトと脆弱性を管理
- [Meeting-Baas/meeting-mcp](https://github.com/Meeting-Baas/meeting-mcp) - 会議ボットの作成、議事録の検索、録画データの管理
- [drumnation/unsplash-smart-mcp-server](https://github.com/drumnation/unsplash-smart-mcp-server) – AIエージェントがUnsplashからプロの写真をシームレスに検索、推奨、配信できるようにする
- [ssmanji89/halopsa-workflows-mcp](https://github.com/ssmanji89/halopsa-workflows-mcp) - HaloPSAワークフローとAIアシスタントの統合
- [aiamblichus/mcp-chat-adapter](https://github.com/aiamblichus/mcp-chat-adapter) – LLMがチャット完了を使用するためのクリーンなインターフェースを提供

## 謝辞

- FastMCPは[Jonathan Lowin](https://github.com/jlowin)による[Python実装](https://github.com/jlowin/fastmcp)に着想を得ています。
- コードベースの一部は[LiteMCP](https://github.com/wong2/litemcp)から採用されました。
- コードベースの一部は[Model Context protocolでSSEをやってみる](https://dev.classmethod.jp/articles/mcp-sse/)から採用されました。