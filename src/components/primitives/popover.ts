import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Breathing room kept between a popover and the window edge. */
const GUTTER = 8

/**
 * Open state, outside-click and Escape handling, and viewport fitting for
 * a popover hung off a toolbar trigger.
 *
 * Every dropdown on the toolbar needs the same four behaviours, and they
 * used to be copied into each one — which is how one of them forgot to keep
 * its panel on screen at 640px.
 *
 * Fitting is MEASURED rather than guessed with a media query: what overflows
 * depends on where the toolbar wrapped, not on a breakpoint. It re-measures
 * whenever the panel resizes, because the time picker grows a calendar pane
 * while open.
 */
export function usePopover<P extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<P>(null)

  useLayoutEffect(() => {
    if (!open) return
    const fit = () => {
      const el = pop.current
      if (!el) return
      el.style.transform = ''
      const r = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const over = r.right - (vw - GUTTER)
      if (over > 0) el.style.transform = `translateX(${-Math.min(over, r.left - GUTTER)}px)`
    }
    fit()
    const ro = new ResizeObserver(fit)
    if (pop.current) ro.observe(pop.current)
    globalThis.addEventListener('resize', fit)
    return () => { ro.disconnect(); globalThis.removeEventListener('resize', fit) }
  }, [open])

  // Close on outside click or Escape, and hand focus back to the trigger —
  // a popover that swallows focus is worse than no popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => { setOpen(false); trigger.current?.focus() }
  return { open, setOpen, close, root, trigger, pop }
}
