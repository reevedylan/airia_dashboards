import { useCallback, useEffect, useRef, useState } from 'react'

/** Measure an element and re-render when it resizes. Charts size themselves
 *  from this rather than taking a fixed width prop. */
export function useSize<T extends HTMLElement>(): [React.RefCallback<T>, { width: number; height: number }] {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const observer = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect()
    if (!node) return
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      setSize((prev) =>
        Math.abs(prev.width - box.width) < 0.5 && Math.abs(prev.height - box.height) < 0.5
          ? prev
          : { width: box.width, height: box.height },
      )
    })
    ro.observe(node)
    observer.current = ro
  }, [])

  useEffect(() => () => observer.current?.disconnect(), [])
  return [ref, size]
}
