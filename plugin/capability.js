/**
 * 运行时能力判断 —— 插件的"眼睛"。
 *
 * 权威写法照抄自 DSH 官方 `read_image` 闸门:
 *   $DSH/dsh-tool-fs/lib/index.js:890-898 (assertImageCapableRoute)
 *
 * 语义:inputModalities 缺省 = 未知 → 按"不支持图片"处理(与官方闸门一致),
 * 显式含 'image' 才算原生支持。纯文本模型(deepseek-v4-flash 等)走桥接分支。
 */

/**
 * 解析会话当前路由(请求头配置优先,其次 agent options),返回该模型是否声明了 image 输入。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文(可访问 ctx.get('llm'))
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec 当前工具调用执行上下文
 * @returns {Promise<boolean>}
 */
export async function routeSupportsImage(ctx, exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  const llm = ctx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) return false;
  let active;
  try {
    active = await llm.resolveModelInfo(provider, model, exec.signal);
  } catch {
    // 路由解析失败(模型不存在等):保守按"不支持"处理,交给官方闸门报错
    return false;
  }
  return active?.inputModalities !== undefined && active.inputModalities.includes('image');
}
