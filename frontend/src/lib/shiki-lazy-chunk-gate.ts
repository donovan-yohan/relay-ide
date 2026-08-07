function isShikiRuntimeModule(moduleId: string): boolean {
  const normalized = moduleId.replaceAll('\\', '/');
  return (
    normalized.includes('/node_modules/shiki/') ||
    normalized.includes('/node_modules/@shikijs/')
  );
}

export interface ShikiChunkGraphNode {
  fileName: string;
  isEntry: boolean;
  imports: readonly string[];
  dynamicImports: readonly string[];
  moduleIds: readonly string[];
}

/**
 * Return a build-gate failure when Shiki is absent, statically reachable from
 * an entry, or emitted outside every entry's dynamic-import graph.
 */
export function shikiLazyChunkViolation(
  chunks: readonly ShikiChunkGraphNode[]
): string | null {
  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const staticReachable = new Set<string>();
  const dynamicReachable = new Set<string>();
  const queue = chunks
    .filter((chunk) => chunk.isEntry)
    .map((chunk) => ({ fileName: chunk.fileName, crossedDynamicEdge: false }));

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]!;
    const reached = current.crossedDynamicEdge
      ? dynamicReachable
      : staticReachable;
    if (reached.has(current.fileName)) continue;
    reached.add(current.fileName);

    const chunk = byFileName.get(current.fileName);
    if (!chunk) continue;
    for (const imported of chunk.imports) {
      queue.push({
        fileName: imported,
        crossedDynamicEdge: current.crossedDynamicEdge,
      });
    }
    for (const imported of chunk.dynamicImports) {
      queue.push({ fileName: imported, crossedDynamicEdge: true });
    }
  }

  const shikiChunks = chunks.filter((chunk) =>
    chunk.moduleIds.some(isShikiRuntimeModule)
  );
  if (shikiChunks.length === 0) {
    return 'Shiki lazy chunk missing from frontend build';
  }

  const eagerShikiChunk = shikiChunks.find((chunk) =>
    staticReachable.has(chunk.fileName)
  );
  if (eagerShikiChunk) {
    const moduleId = eagerShikiChunk.moduleIds.find(isShikiRuntimeModule);
    return `Shiki must remain lazy; entry static graph includes ${moduleId ?? eagerShikiChunk.fileName}`;
  }

  const unreachableShikiChunk = shikiChunks.find(
    (chunk) => !dynamicReachable.has(chunk.fileName)
  );
  if (unreachableShikiChunk) {
    return `Shiki chunk ${unreachableShikiChunk.fileName} is not reachable through a dynamic import from an entry`;
  }
  return null;
}
