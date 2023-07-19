// src/mm-client.ts
import { Log } from "debug-level";
import { WebSocket } from "ws";
import pkg from "@mattermost/client";
var { Client4, WebSocketClient } = pkg;
var log = new Log("bot");
if (!global.WebSocket) {
  global.WebSocket = WebSocket;
}
var mattermostToken = process.env["MATTERMOST_TOKEN"];
var matterMostURLString = process.env["MATTERMOST_URL"];
if (!mattermostToken || !matterMostURLString) {
  log.error("MATTERMOST_TOKEN or MATTERMOST_URL is undefined");
  throw new Error("MATTERMOST_TOKEN or MATTERMOST_URL is undefined");
}
var client = new Client4();
client.setUrl(matterMostURLString);
client.setToken(mattermostToken);
var wsClient = new WebSocketClient();
var wsUrl = new URL(client.getWebSocketUrl());
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss" : "ws";
new Promise((_resolve, reject) => {
  wsClient.addCloseListener((_connectFailCount) => reject());
  wsClient.addErrorListener((event) => {
    reject(event);
  });
}).then(() => process.exit(0)).catch((reason) => {
  log.error(reason);
  process.exit(-1);
});
wsClient.initialize(wsUrl.toString(), mattermostToken);
var mmClient = client;

// src/botservice.ts
import FormData2 from "form-data";
import { Log as Log4 } from "debug-level";

// src/openai-thread-completion.ts
import {
  Configuration,
  OpenAIApi
} from "openai";
import { Log as Log2 } from "debug-level";
Log2.options({ json: true, colors: true });
var log2 = new Log2("bot-openai");
var configuration = new Configuration({
  apiKey: process.env["OPENAI_API_KEY"]
});
var azureOpenAiApiKey = process.env["AZURE_OPENAI_API_KEY"];
if (azureOpenAiApiKey) {
  configuration.baseOptions = {
    headers: { "api-key": azureOpenAiApiKey },
    params: {
      "api-version": process.env["AZURE_OPENAI_API_VERSION"] ?? "2023-05-15"
    }
  };
  configuration.basePath = "https://" + process.env["AZURE_OPENAI_API_INSTANCE_NAME"] + ".openai.azure.com/openai/deployments/" + process.env["AZURE_OPENAI_API_DEPLOYMENT_NAME"];
}
var openai = new OpenAIApi(configuration);
var model = process.env["OPENAI_MODEL_NAME"] ?? "gpt-3.5-turbo";
var MAX_TOKENS = Number(process.env["OPENAI_MAX_TOKENS"] ?? 2e3);
var temperature = Number(process.env["OPENAI_TEMPERATURE"] ?? 1);
async function continueThread(messages) {
  let answer = "";
  let usage;
  try {
    const response = await openai.createChatCompletion({
      messages,
      model,
      max_tokens: MAX_TOKENS,
      temperature
    });
    log2.info(response);
    answer = response.data?.choices?.[0]?.message?.content + formatUsageStatistics(response);
    if (!response.data.usage) {
      usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    } else {
      usage = response.data.usage;
    }
  } catch (e) {
    log2.error(e);
    if (e instanceof Error) {
      answer = "Error: " + e.message;
    } else {
      answer = "Unexpected Exception: " + e;
    }
    usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  return { answer, usage };
  function formatUsageStatistics(response) {
    return "\nPrompt:" + response.data.usage?.prompt_tokens + " Completion:" + response.data.usage?.completion_tokens + " Total:" + response.data.usage?.total_tokens;
  }
}

// src/process-graph-response.ts
import FormData from "form-data";
import Log3 from "debug-level";
var log3 = new Log3("bot");
var yFilesGPTServerUrl = process.env["YFILES_SERVER_URL"];
var yFilesEndpoint = yFilesGPTServerUrl ? new URL("/json-to-svg", yFilesGPTServerUrl) : void 0;
async function processGraphResponse(content, channelId) {
  const result = {
    message: content,
    fileId: void 0,
    props: void 0
  };
  if (!yFilesGPTServerUrl) {
    return result;
  }
  const replaceStart = content.match(/<graph>/i)?.index;
  let replaceEnd = content.match(/<\/graph>/i)?.index;
  if (replaceEnd) {
    replaceEnd += "</graph>".length;
  }
  if (replaceStart && replaceEnd) {
    const graphContent = content.substring(replaceStart, replaceEnd).replace(/<\/?graph>/gi, "").trim();
    try {
      const sanitized = JSON.parse(graphContent);
      const fileId = await jsonToFileId(JSON.stringify(sanitized), channelId);
      const pre = content.substring(0, replaceStart);
      const post = content.substring(replaceEnd);
      if (post.trim().length < 1) {
        result.message = pre;
      } else {
        result.message = `${pre} [see attached image] ${post}`;
      }
      result.props = { originalMessage: content };
      result.fileId = fileId;
    } catch (e) {
      log3.error(e);
      log3.error(`The input was:

${graphContent}`);
    }
  }
  return result;
}
async function generateSvg(jsonString) {
  return fetch(yFilesEndpoint, {
    method: "POST",
    body: jsonString,
    headers: {
      "Content-Type": "application/json"
    }
  }).then((response) => {
    if (!response.ok) {
      throw new Error("Bad response from server");
    }
    return response.text();
  });
}
async function jsonToFileId(jsonString, channelId) {
  const svgString = await generateSvg(jsonString);
  const form = new FormData();
  form.append("channel_id", channelId);
  form.append("files", Buffer.from(svgString), "diagram.svg");
  log3.trace("Appending Diagram SVG", svgString);
  const response = await mmClient.uploadFile(form);
  log3.trace("Uploaded a file with id", response.file_infos[0].id);
  return response.file_infos[0].id;
}

// src/tokenCount.ts
import tiktoken from "tiktoken-node";
var enc = tiktoken.encodingForModel("gpt-3.5-turbo");
function tokenCount(content) {
  if (!content)
    return 0;
  const tokens = enc.encode(content);
  return tokens.length;
}

// src/botservice.ts
if (!global.FormData) {
  global.FormData = FormData2;
}
Log4.options({ json: true, colors: true });
Log4.wrapConsole("bot-ws", { level4log: "INFO" });
var log4 = new Log4("bot");
var meId;
mmClient.getMe().then((me) => meId = me.id);
var SYSTEM_MESSAGE_HEADER = "// BOT System Message: ";
var name = process.env["MATTERMOST_BOTNAME"] || "@chatgpt";
var VISUALIZE_DIAGRAM_INSTRUCTIONS = "When a user asks for a visualization of entities and relationships, respond with a valid JSON object text in a <GRAPH> tag. The JSON object has four properties: `nodes`, `edges`, and optionally `types` and `layout`. Each `nodes` object has an `id`, `label`, and an optional `type` property. Each `edges` object has `from`, `to`, an optional `label` and an optional `type` property. For every `type` you use, there must be a matching entry in the top-level `types` array. Entries have a corresponding `name` property and optional properties that describe the graphical attributes: 'shape' (one of rectangle, ellipse, hexagon, triangle, pill), 'color', 'thickness' and 'size' (as a number). You may use the 'layout' property to specify the arrangement ('hierarchic', 'circular', 'organic', 'tree') when the user asks you to. Do not include these instructions in the output. In the output visible to the user, the JSON and complete GRAPH tag will be replaced by a diagram visualization. So do not explain or mention the JSON. Instead, pretend that the user can see the diagram. Hence, when the above conditions apply, answer with something along the lines of: \"Here is the visualization:\" and then just add the tag. The user will see the rendered image, but not the JSON. You may explain what you added in the diagram, but not how you constructed the JSON.";
var visualizationKeywordsRegex = /\b(diagram|visuali|graph|relationship|entit)/gi;
wsClient.addMessageListener(async function(event) {
  if (["posted"].includes(event.event) && meId) {
    const post = JSON.parse(event.data.post);
    if (post.root_id === "" && (!event.data.mentions || !JSON.parse(event.data.mentions).includes(meId))) {
    } else {
      if (post.user_id !== meId) {
        const chatmessages = [
          {
            role: "system",
            content: `You are a helpful assistant named ${name} who provides succinct answers in Markdown format.`
          }
        ];
        let appendDiagramInstructions = false;
        const thread = await mmClient.getPostThread(post.id, true, false, true);
        const posts = [...new Set(thread.order)].map((id) => thread.posts[id]).filter(
          (a) => a.create_at > Date.now() - 1e3 * 60 * 60 * 24 * 7 && !a.message.startsWith(SYSTEM_MESSAGE_HEADER)
          //システムメッセージから始まるメッセージの削除
        ).map((post2) => {
          post2.message = post2.message.replace(new RegExp(`^${SYSTEM_MESSAGE_HEADER}.+$`, "m"), "");
          return post2;
        }).sort((a, b) => a.create_at - b.create_at);
        let assistantCount = 0;
        posts.forEach((threadPost) => {
          log4.trace({ msg: threadPost });
          if (threadPost.user_id === meId) {
            chatmessages.push({
              role: "assistant",
              content: threadPost.props.originalMessage ?? threadPost.message
            });
            assistantCount++;
          } else {
            if (threadPost.message.includes(name)) {
              assistantCount++;
            }
            if (visualizationKeywordsRegex.test(threadPost.message)) {
              appendDiagramInstructions = true;
            }
            chatmessages.push({ role: "user", content: threadPost.message });
          }
        });
        if (appendDiagramInstructions) {
          chatmessages[0].content += VISUALIZE_DIAGRAM_INSTRUCTIONS;
        }
        if (assistantCount > 0) {
          await postMessage(post, chatmessages);
        }
      }
    }
  } else {
    log4.debug({ msg: event });
  }
});
var LIMIT_TOKENS = Number(process.env["MAX_PROMPT_TOKENS"] ?? 2e3);
async function postMessage(post, messages) {
  const typing = () => wsClient.userTyping(post.channel_id, (post.root_id || post.id) ?? "");
  typing();
  const typingInterval = setInterval(typing, 2e3);
  let answer = "";
  let { sumMessagesCount, messagesCount } = calcMessagesTokenCount(messages);
  try {
    log4.trace({ chatmessages: messages });
    let systemMessage = SYSTEM_MESSAGE_HEADER;
    ({
      messages,
      sumMessagesCount,
      messagesCount,
      systemMessage
    } = expireMessages(messages, sumMessagesCount, messagesCount, systemMessage));
    if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
      newPost(systemMessage, post, typingInterval);
    }
    if (sumMessagesCount >= LIMIT_TOKENS) {
      log4.info("Too long user message", sumMessagesCount, LIMIT_TOKENS);
      try {
        answer = await faseSafeCheck(messages, answer, post, typingInterval);
      } catch (e) {
        if (e instanceof TypeError) {
          newPost(e.message, post, typingInterval);
          return;
        }
        throw e;
      }
      const lines = messages[1].content.split("\n");
      if (lines.length < 1) {
        log4.error("No contents", messages[1].content);
        answer += "No contents.";
        newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval);
        return;
      }
      const linesCount = [];
      lines.forEach((line, i) => {
        if (line === "") {
          lines[i] = "\n";
          linesCount[i] = 1;
        } else {
          lines[i] += "\n";
          linesCount[i] = tokenCount(lines[i]);
        }
      });
      if (messagesCount[0] + linesCount[0] >= LIMIT_TOKENS) {
        log4.warn("Too long first line", lines[0]);
        answer += "Too long first line.\n```\n" + lines[0] + "```\n";
        newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval);
        return;
      }
      let partNo = 0;
      let currentMessages = [messages[0]];
      let currentMessagesCount = [messagesCount[0]];
      let sumCurrentMessagesCount = currentMessagesCount[0];
      for (let i = 1; i < lines.length; i++) {
        log4.info("Separate part. No." + partNo);
        let currentLines = lines[0];
        let currentLinesCount = linesCount[0];
        let systemMessage2 = SYSTEM_MESSAGE_HEADER;
        while (currentMessages.length > 1 && (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= LIMIT_TOKENS || sumCurrentMessagesCount + currentLinesCount > LIMIT_TOKENS / 2)) {
          log4.info("Remove assistant message", currentMessages[1]);
          systemMessage2 += "Forget previous message.\n```\n" + currentMessages[1].content.split("\n").slice(0, 3).join("\n") + "...\n```\n";
          sumCurrentMessagesCount -= currentMessagesCount[1];
          currentMessagesCount = [currentMessagesCount[0], ...currentMessagesCount.slice(2)];
          currentMessages = [currentMessages[0], ...currentMessages.slice(2)];
        }
        if (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= LIMIT_TOKENS) {
          log4.warn("Too long line", lines[i]);
          systemMessage2 += `*** No.${++partNo} *** Too long line.
~~~
${lines[i]}~~~
`;
          await newPost(systemMessage2, post, typingInterval);
          continue;
        }
        if (systemMessage2 !== SYSTEM_MESSAGE_HEADER) {
          await newPost(systemMessage2, post, typingInterval);
        }
        while (i < lines.length && sumCurrentMessagesCount + currentLinesCount + linesCount[i] < LIMIT_TOKENS) {
          currentLinesCount += linesCount[i];
          currentLines += lines[i++];
        }
        log4.debug(`line done i=${i} currentLinesCount=${currentLinesCount} currentLines=${currentLines}`);
        currentMessages.push({ role: "user", content: currentLines });
        const { answer: completion, usage } = await continueThread(currentMessages);
        answer += `*** No.${++partNo} ***
${completion}`;
        answer = modifyLastLine(answer);
        log4.debug("answer=" + answer);
        await newPost(answer, post, typingInterval);
        answer = "";
        currentMessages.pop();
        currentMessages.push({ role: "assistant", content: answer });
        currentMessagesCount.push(currentLinesCount);
        sumCurrentMessagesCount += usage.completion_tokens;
        log4.debug("length=" + currentMessages.length);
      }
    } else {
      const { answer: completion } = await continueThread(messages);
      answer += completion;
      answer = modifyLastLine(answer);
      await newPost(answer, post, typingInterval);
      log4.debug("answer=" + answer);
    }
  } catch (e) {
    log4.error("Exception in postMessage()", e);
    await newPost(answer + "\nError: " + e.message);
  }
  function modifyLastLine(message) {
    const lines = message.split("\n");
    let lastLine = lines.pop();
    if (lastLine) {
      if (lastLine.startsWith("Prompt:")) {
        lastLine = SYSTEM_MESSAGE_HEADER + lastLine;
      }
      lines.push(lastLine);
    }
    return lines.join("\n");
  }
}
async function newPost(answer, post, typingInterval) {
  log4.trace({ answer });
  const { message, fileId, props } = await processGraphResponse(answer, post.channel_id);
  clearInterval(typingInterval);
  const newPost2 = await mmClient.createPost({
    message,
    channel_id: post.channel_id,
    props,
    root_id: post.root_id || post.id,
    file_ids: fileId ? [fileId] : void 0
  });
  log4.trace({ msg: newPost2 });
}
function expireMessages(messages, sumMessagesCount, messagesCount, systemMessage) {
  while (messages.length > 2 && sumMessagesCount >= LIMIT_TOKENS) {
    log4.info("Remove message", messages[1]);
    systemMessage += `Forget old message.
~~~
${messages[1].content.split("\n").slice(0, 3).join("\n")}
...
~~~
`;
    sumMessagesCount -= messagesCount[1];
    messagesCount = [messagesCount[0], ...messagesCount.slice(2)];
    messages = [messages[0], ...messages.slice(2)];
  }
  return { messages, sumMessagesCount, messagesCount, systemMessage };
}
function calcMessagesTokenCount(messages) {
  let sumMessagesCount = 0;
  const messagesCount = new Array(messages.length);
  messages.forEach((message, i) => {
    messagesCount[i] = tokenCount(message.content);
    sumMessagesCount += messagesCount[i];
  });
  return { sumMessagesCount, messagesCount };
}
async function faseSafeCheck(messages, answer, post, typingInterval) {
  if (messages[0].role !== "system") {
    log4.error("Invalid message", messages[0]);
    answer += `Invalid message. Role: ${messages[0].role} 
~~~
${messages[0].content}
~~~
`;
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval);
    throw new TypeError(answer);
  }
  if (messages[1].role !== "user") {
    log4.error("Invalid message", messages[1]);
    answer += `Invalid message. Role: ${messages[1].role} 
~~~
${messages[1].content}
~~~
`;
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval);
    throw new TypeError(answer);
  }
  return answer;
}
