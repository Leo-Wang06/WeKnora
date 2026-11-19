/**
 * 为「请求信息」调试面板净化一次流式 POST 请求体。
 * 
 * 这里的「调试面板」不是一个独立的开发者工具页面，
 * 而是助手回答下方那个小圆形「i」按钮弹出的浮层（ChatRequestInfoButton），
 * 标题是「请求信息」
 *
 * 返回一份浅拷贝，不修改传入的 body；实际发送仍使用原始对象。
 * - `images` / `attachment_uploads`：大体积 base64 内容替换为占位符和字节数；
 * - `query`：超过 500 字符时截断，并在末尾标注原始长度；
 * - 其余业务字段原样保留，便于排查和复现问题。
 *
 * @param body 已组装好的 POST 请求体
 * @returns 可安全展示、复制和 JSON 序列化的请求体副本
 */
export function sanitizeStreamRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  // 上传的图片是否为数组，也就是是否为多个
  if (Array.isArray(out.images)) {
    out.images = out.images.map((img: { data?: string }, i: number) => ({
      _placeholder: `image[${i}]`,
      bytes: typeof img?.data === 'string' ? img.data.length : 0,
    }));
  }
  // 上传的附件是否为数组，也就是是否为多个
  if (Array.isArray(out.attachment_uploads)) {
    out.attachment_uploads = out.attachment_uploads.map(
      (att: { file_name?: string; file_size?: number; data?: string }, i: number) => ({
        file_name: att.file_name,
        file_size: att.file_size,
        _placeholder: `attachment[${i}]`,
        bytes: typeof att?.data === 'string' ? att.data.length : 0,
      }),
    );
  }
  // 当问题文本超过 500 个字符时，将字符串进行截断，取前 500 个字符，加上省略号以及原始长度
  // （前 500 字）… (2837 chars)
  if (typeof out.query === 'string' && out.query.length > 500) {
    out.query = `${out.query.slice(0, 500)}… (${out.query.length} chars)`;
  }
  return out;
}

// 它是“最近一次流式请求的、经过脱敏和裁剪的诊断快照”。
// 说它存的是“本次请求的信息”没错，
// 但不是完整、逐字节的请求记录。
export interface StreamRequestMeta {
  // 前端生成的 12 位随机串，同时作为 X-Request-ID 发给后端
  requestId: string; 
  // 实际请求 URL，含 API base、session_id 路径、GET 时的 message_id 查询参数
  url: string;
  // 本次调用的 POST / GET
  method: string;
  // POST 时是 sanitizeStreamRequestBody(postBody) 的副本：
  // 图片/附件 base64 换成占位符 + 字节数，超长 query 截断；
  // GET 时为 null
  body: Record<string, unknown> | null;
  // 快照创建时的 Date.now() 墙上时间
  sentAt: number;
}

export interface ChatRequestDebugInfo {
  requestId?: string;
  messageId?: string;
  sessionId?: string;
  url?: string;
  method?: string;
  body?: Record<string, unknown> | null;
  sentAt?: number;
}

export function buildChatRequestDebugPayload(info: ChatRequestDebugInfo): string {
  return JSON.stringify(info, null, 2);
}
