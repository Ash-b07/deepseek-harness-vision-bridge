/**
 * 测试共用工具:假 ctx / 假 exec / 微型 PNG。
 */

/** 1x1 透明 PNG。 */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 构造一个假 fs 服务(只实现插件用到的 resolve/stat/readBytes)。 */
export function fakeFs({ bytes = TINY_PNG, displayPath } = {}) {
  return {
    async resolve(path, opts = {}) {
      return { displayPath: displayPath ?? path, rawPath: path, opts };
    },
    async stat() {
      return { type: 'file', version: 1 };
    },
    async readBytes() {
      return new Uint8Array(bytes);
    },
  };
}

/** 构造一个假 llm 服务。 */
export function fakeLlm(inputModalities) {
  return {
    async resolveModelInfo() {
      return { inputModalities };
    },
    registerAdapter() {
      return { dispose() {}, replace() {} };
    },
  };
}

/** 构造一个假 exec(工具调用执行上下文)。 */
export function fakeExec({ name, args = {}, inputModalities = ['text'] } = {}) {
  return {
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: {
      session: {
        requestHeader: () => ({
          config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        }),
        header: { cwd: '/tmp' },
      },
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      llm: fakeLlm(inputModalities),
    },
  };
}

/** 构造一个假 ctx(插件 apply 收到的上下文)。 */
export function fakeCtx({ fs, llm, attachments } = {}) {
  const services = {
    fs: fs ?? fakeFs(),
    llm: llm ?? fakeLlm(['text']),
    attachments,
  };
  const registeredTools = [];
  const handlers = {};
  return {
    ...services, // 真实 cordis 中注入的服务是 ctx 的直接属性(ctx.fs / ctx.llm)
    services,
    registeredTools,
    handlers,
    get(name) {
      return services[name];
    },
    tools: {
      register(definition) {
        registeredTools.push(definition);
        return () => {};
      },
    },
    on(event, handler) {
      handlers[event] = handler;
      return () => {};
    },
  };
}

/** 断言辅助。 */
export function assert(cond, message) {
  if (!cond) throw new Error(`断言失败:${message}`);
}

/** DSH 允许的 JSON Schema 关键字子集(照抄 dsh-tools/lib/types/json-schema.js)。 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/**
 * 断言一份 schema 是「对象根」且落在 DSH 允许的子集内 —— 这正是原始 ctx.tools.register()
 * 不替你做、但 DeepSeek 服务端会当场拒掉的那道检查。
 */
export function assertObjectJsonSchema(schema, label) {
  assert(schema !== null && typeof schema === 'object', `${label} 应为对象`);
  assert(schema.type === 'object', `${label}.type 必须是 "object"(当前:${JSON.stringify(schema.type)})`);
  assert(
    schema.properties !== undefined && typeof schema.properties === 'object',
    `${label}.properties 缺失`,
  );
  if (schema.required !== undefined) {
    assert(Array.isArray(schema.required), `${label}.required 必须是数组(不是每个字段上的布尔)`);
    for (const key of schema.required) {
      assert(key in schema.properties, `${label}.required 里的 ${key} 不在 properties 中`);
    }
  }
  for (const [key, node] of Object.entries(schema.properties)) {
    assertJsonSchemaNode(node, `${label}.properties.${key}`);
  }
}

/** 递归校验单个 schema 节点:关键字白名单 + 合法 type + required 只能是数组。 */
function assertJsonSchemaNode(node, label) {
  assert(node !== null && typeof node === 'object', `${label} 应为对象`);
  for (const key of Object.keys(node)) {
    assert(ALLOWED_KEYWORDS.has(key), `${label} 含不支持的关键字 ${key}`);
  }
  assert(SCHEMA_TYPES.includes(node.type), `${label}.type 非法:${JSON.stringify(node.type)}`);
  assert(!Array.isArray(node.type), `${label}.type 不支持联合类型`);
  if (node.type === 'object') assertObjectJsonSchema(node, label);
  if (node.type === 'array' && node.items !== undefined) assertJsonSchemaNode(node.items, `${label}.items`);
}
