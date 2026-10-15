/** Update stable DOM nodes so metadata refreshes preserve focus and animations. */
export function reconcileElements<Item, Key>(
  parent: HTMLElement,
  nodes: Map<Key, HTMLElement>,
  items: readonly Item[],
  keyOf: (item: Item) => Key,
  create: (item: Item) => HTMLElement,
  update: (node: HTMLElement, item: Item, index: number) => void = () => {},
) {
  const keys = new Set(items.map(keyOf))
  for (const [key, node] of nodes)
    if (!keys.has(key)) {
      node.remove()
      nodes.delete(key)
    }
  items.forEach((item, index) => {
    const key = keyOf(item)
    let node = nodes.get(key)
    if (!node) {
      node = create(item)
      nodes.set(key, node)
    }
    update(node, item, index)
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null)
  })
}
