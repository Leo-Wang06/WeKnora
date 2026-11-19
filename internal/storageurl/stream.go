package storageurl

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// ── 未完成引用的检测 ──
//
// 内容以 chunk 形式发送给客户端（SSE 的 answer 增量，或 IM 通道 300ms 的
// 刷新批次）。一条存储引用可能被切到两个 chunk 里，因此只看到单个 chunk
// 的重写会留下一个坏掉的片段。这些辅助函数定位 chunk 末尾的未完成片段，
// 让调用方可以把它暂扣到下一个 chunk 将其补全为止。

// incompleteRefSuffixRe 匹配一条延伸到字符串末尾的存储引用——它可能在下一个
// chunk 中继续。
var incompleteRefSuffixRe = regexp.MustCompile(
	`\b(?:resource|storage|local|minio|s3|cos|tos|oss|obs|ks3)://[^\s)\]>"]*$`,
)

// FindIncompleteRef 返回 s 末尾可能被截断的存储引用的字节偏移，找不到则返回 -1。
func FindIncompleteRef(s string) int {
	loc := incompleteRefSuffixRe.FindStringIndex(s)
	if loc == nil {
		return -1
	}
	return loc[0]
}

// incompleteMarkdownImageSuffixRe 匹配目标 URL（括号里的部分）尚未闭合的
// Markdown 图片——例如 "![alt](minio://part" 或 "![alt]("。只从 "minio://" 处
// 暂扣，会把 "![alt](" 刷给客户端，等 URL 在下一个 chunk 到来后图片就断了。
//
// 目标必须不含空白，且 FindIncompleteMarkdownImage 会限制其长度：URL 既不包含
// 空白也不包含换行，即便是一条预签名 URL 也远小于这个上限。没有这些限制，
// 仅仅提到未闭合 "…](" 的普通文字（比如讲解 Markdown 语法的答案，或代码样例）
// 会看起来永远未闭合，从而卡住流的其余部分。
var incompleteMarkdownImageSuffixRe = regexp.MustCompile(`!\[[^\]]*\]\([^)\s]*$`)

// maxIncompleteImageBytes 限制了尾部有多少文本可被当作未完成的 Markdown 图片。
// 超过它之后，这段文本就不太可能是一个链接，因此会被直接刷出而不是缓冲。
const maxIncompleteImageBytes = 2048

// FindIncompleteMarkdownImage 返回 s 末尾未闭合的 `![alt](url` 后缀的字节偏移，
// 找不到则返回 -1。
func FindIncompleteMarkdownImage(s string) int {
	// 优先把尾部的引用片段与前面最近的 `![…](` 配对，这样 alt 文本本身可以包含
	// ']'（例如 `![a[b]](minio://part`）。
	if urlIdx := FindIncompleteRef(s); urlIdx >= 0 {
		if imgIdx := strings.LastIndex(s[:urlIdx], "!["); imgIdx >= 0 {
			if strings.Contains(s[imgIdx:urlIdx], "](") {
				return imgIdx
			}
		}
	}
	loc := incompleteMarkdownImageSuffixRe.FindStringIndex(s)
	if loc == nil || len(s)-loc[0] > maxIncompleteImageBytes {
		return -1
	}
	return loc[0]
}

// HoldbackCutoff 返回 chunk 不再安全刷出的偏移，即可以安全发出的截断位置；
// 当整个 chunk 都能发出时返回 len(chunk)。
func HoldbackCutoff(chunk string) int {
	cutoff := len(chunk)
	if idx := FindIncompleteMarkdownImage(chunk); idx >= 0 && idx < cutoff {
		return idx
	}
	if idx := FindIncompleteRef(chunk); idx >= 0 && idx < cutoff {
		return idx
	}
	return cutoff
}

// maxHeldBytes 限制了每个 key 的暂扣缓冲区大小。一条存储引用加上其 Markdown
// alt 文本远小于这个值；这个上限只是为了防止病态的流（例如一个永不终止的
// 未闭合 "!["）缓冲整个答案。
const maxHeldBytes = 4096

// StreamRewriter 重写流式内容增量中的存储引用。
//
// 每条逻辑流由一个 key 标识（WeKnora 使用 SSE 事件 ID，也就是客户端
// 用于累积内容的同一个 key）。Push 只返回当前可以安全发出的前缀，
// 把可能构成未完成引用的尾部保留下来，直到该 key 的下一次 Push。
//
// 可安全并发使用。
type StreamRewriter struct {
	rewriter *Rewriter

	mu   sync.Mutex
	held map[string]heldContent
}

// heldContent 是保留的尾部内容，以及它来自的事件的元数据；
// 这样当尾部在其流结束后才被释放时，可以重新作为等价事件发出，
// 而不是一个没有上下文的裸片段。
type heldContent struct {
	content string
	meta    interface{}
}

// Held 是一段被释放的尾部：重写后的内容，以及最后一次为其贡献内容的
// Push 所携带的元数据。
type Held struct {
	Content string
	Meta    interface{}
}

// NewStreamRewriter wraps rewriter with per-stream holdback state.
func NewStreamRewriter(rewriter *Rewriter) *StreamRewriter {
	return &StreamRewriter{rewriter: rewriter, held: make(map[string]heldContent)}
}

// Enabled reports whether this StreamRewriter can rewrite anything.
func (s *StreamRewriter) Enabled() bool {
	return s != nil && s.rewriter.Enabled()
}

// Rewriter exposes the underlying Rewriter for stream fields that arrive whole
// (references, metadata) and therefore need no holdback.
func (s *StreamRewriter) Rewriter() *Rewriter {
	if s == nil {
		return nil
	}
	return s.rewriter
}

// Push feeds the next chunk of the stream identified by key and returns the
// rewritten content that is ready to emit. Set flush on the stream's terminal
// chunk to release any held tail. meta is retained opaquely alongside the tail
// and handed back by FlushAll so a late release can carry the same metadata as
// the event it was cut from.
func (s *StreamRewriter) Push(ctx context.Context, key, chunk string, flush bool, meta interface{}) string {
	if !s.Enabled() {
		return chunk
	}

	s.mu.Lock()
	pending := s.held[key].content + chunk
	cutoff := len(pending)
	if !flush {
		cutoff = HoldbackCutoff(pending)
		// Never buffer without bound: release the excess even though it may
		// contain a partial reference, which is what an un-rewritten stream
		// would have shown anyway.
		if len(pending)-cutoff > maxHeldBytes {
			cutoff = runeStart(pending, len(pending)-maxHeldBytes)
		}
	}
	emit := pending[:cutoff]
	if remainder := pending[cutoff:]; remainder == "" {
		delete(s.held, key)
	} else {
		s.held[key] = heldContent{content: remainder, meta: meta}
	}
	s.mu.Unlock()

	return s.rewriter.String(ctx, emit)
}

// runeStart 把 idx 回退到最近的 UTF-8 序列边界，让基于字节的截断永远不会把一个
// 字符切成两半。由模式推导出的截断位置已经落在 ASCII 分隔符上；这个函数只在
// maxHeldBytes 安全阀触发时才起作用。
func runeStart(s string, idx int) int {
	for idx > 0 && !utf8.RuneStart(s[idx]) {
		idx--
	}
	return idx
}

// FlushAll releases every held tail, rewritten, keyed by stream. Callers use it
// when a stream ends without a terminal chunk (for example a client
// disconnect) so buffered content is not silently dropped.
func (s *StreamRewriter) FlushAll(ctx context.Context) map[string]Held {
	if !s.Enabled() {
		return nil
	}
	s.mu.Lock()
	if len(s.held) == 0 {
		s.mu.Unlock()
		return nil
	}
	pending := s.held
	s.held = make(map[string]heldContent)
	s.mu.Unlock()

	out := make(map[string]Held, len(pending))
	for key, held := range pending {
		out[key] = Held{Content: s.rewriter.String(ctx, held.content), Meta: held.meta}
	}
	return out
}
