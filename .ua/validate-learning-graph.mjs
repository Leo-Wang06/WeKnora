import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const graph = JSON.parse(fs.readFileSync(path.join(root, '.ua/knowledge-graph.json'), 'utf8'))
assert.equal(graph.version, '1.0.0')
assert.ok(graph.project.gitCommitHash.length === 40)
assert.equal(graph.layers.length, 15)
assert.equal(graph.tour.length, 15)
const ids = new Set(graph.nodes.map(n => n.id))
assert.equal(ids.size, graph.nodes.length, 'duplicate nodes')
const edgeKeys = new Set()
for (const edge of graph.edges) {
  assert.ok(ids.has(edge.source) && ids.has(edge.target), `dangling edge: ${edge.source} => ${edge.target}`)
  assert.ok(!edgeKeys.has(`${edge.source}|${edge.target}|${edge.type}`), 'duplicate edge')
  edgeKeys.add(`${edge.source}|${edge.target}|${edge.type}`)
}
const used = new Map()
for (const layer of graph.layers) {
  assert.ok(layer.nodeIds.length, `${layer.name} is empty`)
  const inLayer = new Set(layer.nodeIds)
  assert.equal(inLayer.size, layer.nodeIds.length, 'duplicate layer member')
  for (const id of inLayer) {
    assert.ok(ids.has(id), `missing node: ${id}`)
    assert.ok(!used.has(id), `${id} belongs to ${used.get(id)} and ${layer.name}`)
    used.set(id, layer.name)
  }
  assert.ok(layer.nodeIds.some(id => graph.nodes.find(n => n.id === id)?.type === 'file'), `${layer.name} lacks source anchor`)
}
for (const node of graph.nodes) {
  assert.ok(used.has(node.id), `not assigned to a category: ${node.id}`)
  if (!node.filePath) continue
  const normalized = path.normalize(node.filePath)
  assert.ok(normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized), `unsafe path ${node.filePath}`)
  const absolute = path.join(root, ...node.filePath.split('/'))
  assert.ok(fs.existsSync(absolute), `missing source file ${node.filePath}`)
  if (!node.lineRange) continue
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/)
  const [start, end] = node.lineRange
  assert.ok(start >= 1 && end >= start && end <= lines.length, `out-of-range ${node.id}`)
  const declaration = node.name.endsWith('.use') ? 'instance.interceptors.' + node.name : node.name
  assert.ok(lines[start - 1].includes(declaration), `start line not matching symbol: ${node.id} ${start}`)
}
for (const step of graph.tour) {
  assert.ok(graph.layers.some(layer => layer.name === step.title), `tour has unknown category: ${step.title}`)
  assert.ok(step.nodeIds.every(id => ids.has(id)), `tour contains dangling id: ${step.title}`)
}
for (const [source, target] of [
  ['function:frontend/src/main.ts:bootstrap', 'function:frontend/src/stores/auth.ts:refreshFromAuthMe'],
  ['function:frontend/src/utils/request.ts:response.use', 'function:frontend/src/utils/authRefresh.ts:refreshAccessTokenShared'],
  ['function:frontend/src/api/chat/streame.ts:startStream', 'function:frontend/src/utils/authRefresh.ts:runStreamWithAuthRetry'],
  ['function:frontend/src/stores/resourceCache.ts:createCachedResource', 'function:frontend/src/stores/versionedRequest.ts:createVersionedRequestCoordinator'],
  ['endpoint:POST:/api/v1/knowledge-bases/:id/knowledge/file', 'function:internal/handler/knowledge.go:CreateKnowledgeFromFile'],
  ['function:internal/application/service/knowledge_process.go:ProcessDocument', 'function:internal/application/service/knowledge_process.go:processChunks'],
  ['function:internal/application/service/knowledgebase_search_rerank.go:rerankCandidates', 'function:internal/reranking/rerank.go:Rerank'],
  ['function:internal/handler/session/qa.go:completeStreamAssistantMessage', 'function:internal/handler/session/agent_stream_handler.go:publishCompletion'],
  ['function:internal/application/service/datasource_service.go:Emit', 'function:internal/application/service/datasource_service.go:applyFetchedItem'],
]) {
  assert.ok(graph.edges.some(edge => edge.source === source && edge.target === target), `critical link missing: ${source} -> ${target}`)
}
console.log(JSON.stringify({ valid: true, nodes: graph.nodes.length, edges: graph.edges.length, categories: graph.layers.length, tour: graph.tour.length, sourceFiles: graph.nodes.filter(n => n.type === 'file').length, mappedNodes: used.size }, null, 2))
