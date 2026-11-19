package types

import (
	"database/sql/driver"
	"encoding/json"
)

// SearchTargetType represents the type of search target
type SearchTargetType string

const (
	// SearchTargetTypeKnowledgeBase - search entire knowledge base
	SearchTargetTypeKnowledgeBase SearchTargetType = "knowledge_base"
	// SearchTargetTypeKnowledge - search specific knowledge files within a knowledge base
	SearchTargetTypeKnowledge SearchTargetType = "knowledge"
)

// TagScope represents a tag-constrained retrieval scope inside one knowledge base.
type TagScope struct {
	KnowledgeBaseID string   `json:"knowledge_base_id"`
	TagIDs          []string `json:"tag_ids"`
}

// SearchTarget represents a unified search target
// Either search an entire knowledge base, or specific knowledge files within a knowledge base
type SearchTarget struct {
	// Type of search target
	Type SearchTargetType `json:"type"`
	// KnowledgeBaseID is the ID of the knowledge base to search
	KnowledgeBaseID string `json:"knowledge_base_id"`
	// TenantID is the tenant ID that owns this knowledge base
	// Required for cross-tenant shared KB queries
	TenantID uint64 `json:"tenant_id"`
	// KnowledgeIDs is the list of specific knowledge IDs to search within the knowledge base
	// Only used when Type is SearchTargetTypeKnowledge
	KnowledgeIDs []string `json:"knowledge_ids,omitempty"`
	// TagIDs limits retrieval to chunks/documents carrying any of these KB-local tags.
	TagIDs []string `json:"tag_ids,omitempty"`
	// ScopeTagIDs records the logical tag scope selected by the user. For
	// document KBs this is kept for tracing after the relation-table lookup has
	// been resolved to KnowledgeIDs; TagIDs remains the physical index filter.
	ScopeTagIDs []string `json:"scope_tag_ids,omitempty"`
	// DisableRecallThresholds keeps recall broad inside an already constrained,
	// user-selected scope. The reranker still orders candidates, but vector and
	// keyword thresholds cannot erase the whole explicit scope before reranking.
	DisableRecallThresholds bool `json:"disable_recall_thresholds,omitempty"`
}

// SearchTargets is a list of search targets, pre-computed at request entry point
type SearchTargets []*SearchTarget

// RecallThresholds returns the effective recall thresholds for this target.
func (st *SearchTarget) RecallThresholds(vectorThreshold, keywordThreshold float64) (float64, float64) {
	if st != nil && st.DisableRecallThresholds {
		return 0, 0
	}
	return vectorThreshold, keywordThreshold
}

// HasRecallThresholdOverride reports whether any target represents an
// authoritative scope whose candidates must reach reranking before filtering.
func (st SearchTargets) HasRecallThresholdOverride() bool {
	for _, target := range st {
		if target != nil && target.DisableRecallThresholds {
			return true
		}
	}
	return false
}

// HasKnowledgeRetrievalScope reports whether a request has any effective
// knowledge retrieval scope. SearchTargets are the unified runtime form and
// must be considered alongside the legacy/raw KB and knowledge ID fields so
// tag-only mentions are not mistaken for pure chat.
func HasKnowledgeRetrievalScope(
	searchTargets SearchTargets,
	knowledgeBaseIDs []string,
	knowledgeIDs []string,
) bool {
	for _, id := range knowledgeBaseIDs {
		if id != "" {
			return true
		}
	}
	for _, id := range knowledgeIDs {
		if id != "" {
			return true
		}
	}
	for _, target := range searchTargets {
		if target == nil || target.KnowledgeBaseID == "" {
			continue
		}
		if target.Type == SearchTargetTypeKnowledgeBase || len(target.KnowledgeIDs) > 0 ||
			len(target.TagIDs) > 0 || len(target.ScopeTagIDs) > 0 {
			return true
		}
	}
	return false
}

// GetAllKnowledgeBaseIDs returns all unique knowledge base IDs from the search targets
func (st SearchTargets) GetAllKnowledgeBaseIDs() []string {
	seen := make(map[string]bool)
	var result []string
	for _, t := range st {
		if t == nil || t.KnowledgeBaseID == "" {
			continue
		}
		if !seen[t.KnowledgeBaseID] {
			seen[t.KnowledgeBaseID] = true
			result = append(result, t.KnowledgeBaseID)
		}
	}
	return result
}

// GetKBTenantMap returns a map from knowledge base ID to tenant ID
func (st SearchTargets) GetKBTenantMap() map[string]uint64 {
	result := make(map[string]uint64)
	for _, t := range st {
		if t != nil && t.KnowledgeBaseID != "" {
			result[t.KnowledgeBaseID] = t.TenantID
		}
	}
	return result
}

// GetTenantIDForKB returns the tenant ID for a given knowledge base ID
// Returns 0 if not found
func (st SearchTargets) GetTenantIDForKB(kbID string) uint64 {
	for _, t := range st {
		if t != nil && t.KnowledgeBaseID == kbID {
			return t.TenantID
		}
	}
	return 0
}

// ContainsKB checks if the search targets contain a given knowledge base ID
func (st SearchTargets) ContainsKB(kbID string) bool {
	for _, t := range st {
		if t != nil && t.KnowledgeBaseID == kbID {
			return true
		}
	}
	return false
}

// MatchedImage retains an image vector hit's identity before context expansion
// replaces ImageInfo with all images in a surrounding text chunk.
type MatchedImage struct {
	ChunkID         string `json:"chunk_id"`
	KnowledgeBaseID string `json:"knowledge_base_id"`
	URL             string `json:"url"`
}

// SearchResult 表示一条检索结果（命中的分块及其元信息）。
type SearchResult struct {
	// 上下文扩展后仍然可以独立引用的正文片段；仅内部使用，不序列化、不落库。
	CitationSources []*SearchResult `json:"-" gorm:"-"`
	// 分块（chunk）ID。
	ID string `gorm:"column:id"              json:"id" extensions:"x-agent=chunk_id"`
	// 分块正文内容。
	Content string `gorm:"column:content"         json:"content" extensions:"x-agent,x-agent-max-runes=600"`
	// 所属知识/文档 ID。
	KnowledgeID string `gorm:"column:knowledge_id"    json:"knowledge_id" extensions:"x-agent"`
	// 分块在文档中的序号。
	ChunkIndex int `gorm:"column:chunk_index"     json:"chunk_index" extensions:"x-agent"`
	// 知识/文档标题。
	KnowledgeTitle string `gorm:"column:knowledge_title" json:"knowledge_title" extensions:"x-agent"`
	// 分块在原文中的起始位置。
	StartAt int `gorm:"column:start_at"        json:"start_at"`
	// 分块在原文中的结束位置。
	EndAt int `gorm:"column:end_at"          json:"end_at"`
	// 分块序号（与 ChunkIndex 对应，用于排序）。
	Seq int `gorm:"column:seq"             json:"seq"`
	// 融合后的相关性得分（通常基于排名计算）。
	Score float64 `                              json:"score" extensions:"x-agent"`
	// 向量检索自身的相似度，在融合把 Score 替换为基于排名的分数之前；
	// 非向量命中的该值为 0。参见 IndexWithScore.VectorScore。
	VectorScore float64 `json:"-"`
	// 命中类型（向量、关键词、相邻分块、父分块、关系分块、图谱、网络搜索等）。
	MatchType MatchType `                              json:"match_type" extensions:"x-agent"`
	// 子分块 ID 列表。
	SubChunkID []string `                              json:"sub_chunk_id"`
	// 元数据键值对。
	Metadata map[string]string `                              json:"metadata"`

	// 分块类型。
	ChunkType string `json:"chunk_type" extensions:"x-agent"`
	// 父分块 ID。
	ParentChunkID string `json:"parent_chunk_id"`
	// 图片信息（JSON 字符串）。
	ImageInfo string `json:"image_info"`
	// 经过合并、去重和已存引用重放后仍保留的命中图片；存的是存储引用，不是图片字节。
	MatchedImages []MatchedImage `json:"matched_images,omitempty" gorm:"-"`

	// 知识文件名，仅文件类知识使用，保存原始文件名。
	KnowledgeFilename string `json:"knowledge_filename"`

	// 知识来源，例如 "url"。
	KnowledgeSource string `json:"knowledge_source"`

	// 知识的入库渠道（web、api、wechat 等）。
	KnowledgeChannel string `json:"knowledge_channel"`

	// 分块级元数据，例如自动生成的问题。
	ChunkMetadata JSON `json:"chunk_metadata,omitempty"`
	// 重排时排除自动生成的问题文本。知识库关闭问题生成开关时由检索流程置为 true，
	// 也包括那些在索引行被禁用之前就已关闭的知识库。
	SkipGeneratedQuestions bool `json:"-" gorm:"-"`
	// 分块的标题面包屑（heading breadcrumb）；属于嵌入内容（Chunk.EmbeddingContent），
	// 但不属于 Content。仅内部使用。
	ContextHeader string `json:"-"`

	// 向量检索实际命中的内容；FAQ 场景下为命中的问题文本（标准问题或相似问题）。
	MatchedContent string `json:"matched_content,omitempty"`

	// 知识文档的描述。
	KnowledgeDescription string `json:"knowledge_description,omitempty"`

	// 用户自定义的、可安全暴露给模型的元数据。
	KnowledgeCustomMetadata string `json:"knowledge_custom_metadata,omitempty"`

	// 该结果所属的知识库 ID。
	KnowledgeBaseID string `json:"knowledge_base_id,omitempty"`

	// 指回原始文件位置的定位信息，用于引用跳转；合并后的结果携带各分块定位信息的并集。
	SourceLocators SourceLocators `json:"source_locators,omitempty"`

	// 检索时分块的编辑版本号。仅内部使用：合并流程据此判断来源坐标是否仍然可信。
	//
	// 0 表示“从未编辑”，因此任何忘记携带该值的构造路径都会退回到按位置处理（fail open）；
	// 从 JSON 重建的结果（已存储的消息引用）因为该字段不序列化，版本号总是 0，
	// 此时 chunkTrusted 中的长度不变量是剩余的保护。保留显式的 gorm 列，
	// 以便直接扫描数据行时能填充它。
	ContentRevision int `gorm:"column:content_revision" json:"-"`

	// 标记合并流程在检索后替换过 Content（父分块或相邻分块扩展），
	// 因此 StartAt/EndAt 已不再描述正文。仅内部使用，从不序列化。
	ContentRewritten bool `json:"-"`
}

// SearchParams represents the search parameters
type SearchParams struct {
	// QueryText is required unless query_embedding is provided, keyword matching is disabled,
	// and vector matching remains enabled.
	QueryText      string    `json:"query_text" extensions:"x-agent,x-agent-required"`
	QueryEmbedding []float32 `json:"query_embedding,omitempty"`
	// Minimum vector similarity a hit needs; 0 keeps every vector hit.
	VectorThreshold float64 `json:"vector_threshold" extensions:"x-agent"`
	// Minimum keyword score a hit needs; 0 keeps every keyword hit.
	KeywordThreshold float64 `json:"keyword_threshold" extensions:"x-agent"`
	// Number of chunks to return; 0 uses the default.
	MatchCount int `json:"match_count" extensions:"x-agent,x-agent-maximum=30"`
	// Turns keyword matching off, leaving vector matching only.
	DisableKeywordsMatch bool `json:"disable_keywords_match" extensions:"x-agent"`
	// Turns vector matching off, leaving keyword matching only.
	DisableVectorMatch bool `json:"disable_vector_match" extensions:"x-agent"`
	// Limits the search to these documents of the knowledge base.
	KnowledgeIDs    []string `json:"knowledge_ids" extensions:"x-agent,x-agent-maximum=20"`
	TagIDs          []string `json:"tag_ids"` // Tag IDs for filtering (used for FAQ priority filtering)
	ScopeTagIDs     []string `json:"scope_tag_ids,omitempty"`
	OnlyRecommended bool     `json:"only_recommended"`
	// KnowledgeBaseIDs overrides the single KB ID passed to HybridSearch,
	// allowing a single retrieval call to span multiple KBs that share the
	// same embedding model. When empty, HybridSearch uses its own id parameter.
	KnowledgeBaseIDs []string `json:"knowledge_base_ids,omitempty"`
	// SkipContextEnrichment skips fetching parent, nearby, and relation chunks
	// in processSearchResults. Used by the chat pipeline where context assembly
	// is handled separately in the merge stage.
	SkipContextEnrichment bool `json:"skip_context_enrichment,omitempty"`
	// Rerank, when present and enabled, reranks the fused candidates before
	// truncating to MatchCount. Only the hybrid-search API reads it; internal
	// callers rerank on their own.
	Rerank *RerankOptions `json:"rerank,omitempty"`
}

// Value implements the driver.Valuer interface, used to convert SearchResult to database value
func (c SearchResult) Value() (driver.Value, error) {
	return json.Marshal(c)
}

// Scan implements the sql.Scanner interface, used to convert database value to SearchResult
func (c *SearchResult) Scan(value interface{}) error {
	if value == nil {
		return nil
	}
	b, ok := value.([]byte)
	if !ok {
		return nil
	}
	return json.Unmarshal(b, c)
}

// Pagination represents the pagination parameters
type Pagination struct {
	// Page
	Page int `form:"page"      json:"page"      binding:"omitempty,min=1"`
	// Page size
	PageSize int `form:"page_size" json:"page_size" binding:"omitempty,min=1,max=1000"`
}

// GetPage gets the page number, default is 1
func (p *Pagination) GetPage() int {
	if p.Page < 1 {
		return 1
	}
	return p.Page
}

// GetPageSize gets the page size, default is 20
func (p *Pagination) GetPageSize() int {
	if p.PageSize < 1 {
		return 20
	}
	if p.PageSize > 1000 {
		return 1000
	}
	return p.PageSize
}

// Offset gets the offset for database query
func (p *Pagination) Offset() int {
	return (p.GetPage() - 1) * p.GetPageSize()
}

// Limit gets the limit for database query
func (p *Pagination) Limit() int {
	return p.GetPageSize()
}

// PageResult represents the pagination query result
type PageResult struct {
	Total    int64       `json:"total"`     // Total number of records
	Page     int         `json:"page"`      // Current page number
	PageSize int         `json:"page_size"` // Page size
	Data     interface{} `json:"data"`      // Data
}

// NewPageResult creates a new pagination result
func NewPageResult(total int64, page *Pagination, data interface{}) *PageResult {
	return &PageResult{
		Total:    total,
		Page:     page.GetPage(),
		PageSize: page.GetPageSize(),
		Data:     data,
	}
}

// SearchResult metadata for results that rest on an image matched by its own
// vector (an image_vector hit).
const (
	// MetadataKeptBy names why a result was kept other than by its rerank
	// score. A kept result rides outside the ranked top-k: truncating to
	// top-k must not drop it.
	MetadataKeptBy = "kept_by"
	// KeptByImageVector: a pictorial image hit a text reranker rejected and
	// its vector still vouched for.
	KeptByImageVector = "image_vector"
	// MetadataImageVectorMatch marks a result that stands in for an
	// image_vector hit de-duplication dropped as a copy of it, so the image
	// still reaches a model that can see it.
	MetadataImageVectorMatch = "image_vector_match"
)
