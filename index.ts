import {
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import readline from "readline/promises";
import axios from 'axios'
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const sse = new (class RequestSSE {
  request<T extends string>(
    url: T,
    method: any,
    params?: string,
    config?: any & { streamCallback?: (data: any) => any },
  ) {
    const abortController = config?.abortController || new AbortController();
    const timer = setTimeout(() => {
      clearTimeout(timer);
      abortController.abort();
    }, 5 * 60 * 1000);
    const { streamCallback } = (config || {}) as any;
    // @ts-ignore
    return fetch(`${url}`, {
      method,
      body: params as string,
      signal: abortController.signal,
    }).then(async (response) => {
      const contentType = response.headers.get('Content-Type');
      if (contentType !== 'text/event-stream') {
        const data: Promise<{
          msg?: string;
        }> = await response.json();
        return streamCallback?.(data)
      }
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let responseValue;
      let chunks = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return {
            ...responseValue,
            data: {
              result: {
                data: streamCallback?.(null, true),
              },
            },
          };
        }

        const chunk = decoder.decode(value, { stream: true });
        chunks += chunk;
        const abortIndex = chunks.indexOf('\n\n');
        if (!~abortIndex) {
          continue;
        }
        /** 截取一条完整的信息 */
        const event = chunks.slice(0, abortIndex);
        if (event) {
          const parsedEvent = event.split(': ').slice(1).join(': ');
          const parseValue = JSON.parse(parsedEvent);
          if (!responseValue) {
            responseValue = parseValue;
          }
          const { success, msg } = parseValue;
          if (success) {
            streamCallback?.(parseValue)
          } else {
            streamCallback?.(parseValue);
          }
        }

        /** chunk如果过长, 取当前chunk 的剩余部分作为下一次头部信息  */
        chunks = chunks.slice(abortIndex + 2);
      }
    });
  }
  get<T extends string, U extends Record<string, any>, R extends Record<string, any>>(url: T, params?: U, config?: R) {
    return this.request(
      `${url}${params ? `?${new URLSearchParams(params).toString()}` : ''}`,
      'GET',
      void 0,
      config,
    );
  }
  post<T extends any, U extends any = any, R extends any = any>(url: string, params?: U, config?: R) {
    return this.request<string>(url, 'POST', JSON.stringify(params), config) as T;
  }
})();


const app = express();
app.use(express.json());
const PORT = 3000;

// 解决 __dirname 在 ESM 中不可用的问题
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 设置静态文件目录
app.use(express.static(path.join(__dirname, '../public')));

// 启动服务器
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

class MCPClient {
  private mcp: Client;
  private anthropic: any;
  private transport: StdioClientTransport | null = null;
  private sseTransport: SSEClientTransport | null = null;
  private tools: Tool[] = [];

  constructor() {
    this.anthropic = axios.create({
      baseURL: 'https://api.suanli.cn/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-W0rpStc95T7JVYVwDYc29IyirjtpPPby6SozFMQr17m8KWeo',
      },
    })
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }
  // methods will go here
  async connectToSSEServer(ser: string) {
    console.log('[ server ] >')
    this.sseTransport = new SSEClientTransport(new URL('http://localhost:3001/sse'));
    this.sseTransport.onerror = (err) => {
      console.error('[SSE Error]', err);
    };
    await this.mcp.connect(this.sseTransport);
    const toolsResult = await this.mcp.listTools();
    console.log('[ toolsResult ] >', toolsResult)
    this.tools = toolsResult.tools.map((tool) => {
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      };
    });
    console.log(
      "Connected to server with tools:",
      this.tools.map(({ name }) => name)
    );
  }

  async connectToServer(serverScriptPath: string) {
    try {
      const isJs = serverScriptPath.endsWith(".js");
      const isPy = serverScriptPath.endsWith(".py");
      if (!isJs && !isPy) {
        throw new Error("Server script must be a .js or .py file");
      }
      const command = isPy
        ? process.platform === "win32"
          ? "python"
          : "python3"
        : process.execPath;

      this.transport = new StdioClientTransport({
        command,
        args: [serverScriptPath],
      });
      this.mcp.connect(this.transport);

      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => {
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        };
      });
      console.log(
        "Connected to server with tools:",
        this.tools.map(({ name }) => name)
      );
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  async processQuery(query: string) {
    const messages: any[] = [
      {
        role: "system",
        content: `
        ## 你是一个智能助手，你的名字是 MCP 助手。你可以调用 MCP 服务器上的工具来帮助用户。
        ## 你可以调用的工具包括：
        ${this.tools
            .map((tool) => {
              return `
            ${tool.name}: ${tool.description}
            `;
            })
            .join("\n")}
        ## 约束
        - 解析出来的中文需要转换成英文
        - 如果是location字段的话需要变成city字段
        - 其他字段比如days什么的都要带上
        - 如果是明天、后天等字样，需要在今天的日期上加1天

        ## few-shot
        1. {city: '杭州'} -> {city: 'hangzhou'}
        2. {location: 'hangzhou'} -> { city: 'hangzhou' }
        3. {city: '杭州', days: 1} -> {city: 'hangzhou', days: 1}
        `
      },
      {
        role: "user",
        content: query,
      },
    ];
    // console.log('[ messages ] >', messages)
    return this.anthropic.post('', {
      model: "free:QwQ-32B",
      max_tokens: 1000,
      messages,
      tools: this.tools,
    }).then(async (response: any) => {
      const { tool_calls } = response?.data?.choices?.[0].message
      console.log('[ content ] >', response?.data?.choices?.[0], tool_calls)
      const finalText = [];
      const toolResults = [];
      for (const content of tool_calls) {
        if (content.type === "text") {
          finalText.push(content.text);
        } else if (content.type === "function") {
          const toolName = content.function.name;
          const toolArgs = JSON.parse(content.function.arguments) as { [x: string]: unknown } | undefined;
          // console.log('[ toolArgs ] >', toolArgs)
          const result = await this.mcp.callTool({
            name: toolName,
            arguments: toolArgs,
          });
          console.log('[ result ] >', result)
          // 使用类型断言来确保 content 是数组类型
          const toolResult = JSON.parse((result.content as any[])?.[0]?.text)

          messages.push({
            role: "system",
            content: `
              ## 你是一个精通英文转中文的资深翻译官
              ## 你的任务就是把英文翻译成中文
              ## few-shot
              1. [{ date: '2025-03-21', temperature: '18.95', conditions: 'clear sky' }] ->  杭州的天气信息: 日期是2025-03-21，温度是18.95，天气是晴天。
              2. [{ date: '2025-03-22', temperature: '18.95', conditions: 'clear sky' }, { date: '2025-03-22', temperature: '10.95', conditions: 'clear sky' }] 
                 转换成
                 - 杭州的天气信息: 日期是2025-03-21，温度是18.95，天气是晴天。
                 - 杭州的天气信息: 日期是2025-03-22，温度是10.95，天气是晴天。
              你拥有的数据如下
              ${JSON.stringify(toolResult)}
            `
          });
          console.log('[ sse - start ] >')
          const response = await sse.post('', {
            model: "free:QwQ-32B",
            max_tokens: 2000,
            messages,
            stream: true
          }, {
            streamCallback(data: any) {
              console.log('[ data ] >', data)
            }
          });
          // console.log('[ response ] >', response)
          // const { content: rContent } = response?.data?.choices?.[0].message
          // console.log('[ response?.data ] >', response?.data?.choices?.[0])
          // finalText.push(
          //   rContent
          // );
          // console.log('[ sse - end ] >', response?.data?.choices?.[0]?.message?.content)
          // return response?.data?.choices?.[0]?.message?.content
        }
      }
    }).catch((err: any) => {
      console.log('[ err ] >', err)
    })
  }

  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log("\nMCP Client Started!");
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question("\nQuery: ");
        if (message.toLowerCase() === "quit") {
          break;
        }
        console.log('[ processQuery ] >', message)
        const response = await this.processQuery(message);
        console.log("\n" + response);
      }
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    await this.mcp.close();
  }
}

const mcpClient = new MCPClient();
async function main() {
  try {
    await mcpClient.connectToServer(process.argv[2]);
    // await mcpClient.chatLoop();
  } finally {
    // await mcpClient.cleanup();
    // process.exit(0);
  }
}

main()
app.post('/get_weather', async (req, res) => {
  // res.send('Hello, Express with ESM!');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Transfer-Encoding', 'chunked'); // 确保传输是分块的
  res.removeHeader('Content-Length');
  try {
    return await mcpClient.processQuery(req.body.message);

    // const data =
    //   // const data = '123'
    //   console.log('[ data ] >', data)
    // res.send('1')
    // res.write({
    //   code: 200,
    //   success: true,
    //   data
    // })
    // // 保持连接
    // setInterval(() => {
    //   res.write(`data: Heartbeat\n\n`); // 发送定期心跳包
    // }, 10000);  // 每10秒发送一次心跳包，保持连接活跃
  } catch (err) {
    console.log('[ get_weather err ] >', err)
  }
});