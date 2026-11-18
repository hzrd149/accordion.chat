/** Revoking a blob URL does not clear an already decoded <img>. Never pass
 * historical slides to a viewer after their current rendering scope is retired. */
export function authorizedMediaSlides<T extends { src: string }>(
  slides: readonly T[] | undefined,
  authorizedSources: Iterable<string>,
): T[] {
  const allowed = new Set(authorizedSources);
  return slides?.filter((slide) => allowed.has(slide.src)) ?? [];
}
