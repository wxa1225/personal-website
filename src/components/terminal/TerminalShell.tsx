import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import './terminal.css'

type Line = { tone?: 'fg' | 'muted' | 'primary' | 'ok' | 'err'; text: string }
type Entry = { kind: 'input'; raw: string } | { kind: 'output'; lines: Line[] }

const pages: Record<string, string> = {
  home: '/',
  blog: '/blog',
  notes: '/notes',
  talks: '/talks',
  projects: '/projects',
  links: '/links',
  about: '/about',
  contact: '/contact'
}

const commandNames = [
  'help', 'whoami', 'about', 'ls', 'pwd', 'cd', 'open', 'github', 'status',
  'theme', 'date', 'clear', 'exit', ...Object.keys(pages)
]

export default function TerminalShell({ user = 'sia', host = 'siaspace' }) {
  const [collapsed, setCollapsed] = useState(false)
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const focusInput = useCallback(() => {
    if (collapsed) setCollapsed(false)
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [collapsed])

  const push = useCallback((lines: Line[]) => {
    setEntries((current) => [...current, { kind: 'output', lines }])
  }, [])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [entries])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (event.key === '`' && !isTyping) {
        event.preventDefault()
        document.querySelector('#interactive-terminal')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        focusInput()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusInput])

  const execute = useCallback((rawValue: string) => {
    const raw = rawValue.trim()
    if (!raw) return
    setEntries((current) => [...current, { kind: 'input', raw }])
    const [command, ...args] = raw.toLowerCase().split(/\s+/)

    if (command === 'help') {
      push([
        { tone: 'primary', text: 'Available commands — try them out.' },
        { text: '  help                 list available commands' },
        { text: '  whoami / about       short introduction' },
        { text: '  ls                   list site sections' },
        { text: '  cd <page>            navigate to a section' },
        { text: '  open <page>          open a section' },
        { text: '  github               open GitHub profile' },
        { text: '  status               show deployment status' },
        { text: '  theme                toggle light / dark mode' },
        { text: '  clear                clear terminal history' }
      ])
      return
    }
    if (command === 'whoami' || command === 'about') {
      push([
        { tone: 'primary', text: 'Sia' },
        { text: 'Developer · Builder · Lifelong Learner' },
        { tone: 'muted', text: '记录技术、项目与持续发生的思考。' }
      ])
      return
    }
    if (command === 'ls') {
      push([{ text: Object.keys(pages).map((page) => `${page}/`).join('   ') }])
      return
    }
    if (command === 'pwd') {
      push([{ text: window.location.pathname }])
      return
    }
    if (command === 'github') {
      push([{ tone: 'muted', text: 'opening github.com/wxa1225 ...' }])
      window.open('https://github.com/wxa1225', '_blank', 'noopener,noreferrer')
      return
    }
    if (command === 'status') {
      push([
        { tone: 'ok', text: '● ONLINE' },
        { text: 'Vercel · Astro · https://siaspace.vercel.app' }
      ])
      return
    }
    if (command === 'theme') {
      document.querySelector<HTMLButtonElement>('#toggleDarkMode')?.click()
      push([{ tone: 'ok', text: 'theme toggled' }])
      return
    }
    if (command === 'date') {
      push([{ text: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'medium' }).format(new Date()) }])
      return
    }
    if (command === 'clear') {
      setEntries([])
      return
    }
    if (command === 'exit') {
      setCollapsed(true)
      inputRef.current?.blur()
      return
    }

    const destination = command === 'cd' || command === 'open'
      ? (args[0] || 'home').replace(/^\//, '')
      : command
    if (destination in pages) {
      push([{ tone: 'muted', text: `opening ${destination} ...` }])
      window.location.href = pages[destination]
      return
    }
    push([
      { tone: 'err', text: `command not found: ${command}` },
      { tone: 'muted', text: "type 'help' to see available commands" }
    ])
  }, [push])

  const complete = useCallback(() => {
    const token = input.toLowerCase().split(/\s+/).pop() || ''
    const candidates = commandNames.filter((name) => name.startsWith(token))
    if (candidates.length === 1) {
      const parts = input.split(/\s+/)
      parts[parts.length - 1] = candidates[0]
      setInput(parts.join(' '))
    } else if (candidates.length > 1) {
      push([{ tone: 'muted', text: candidates.join('   ') }])
    }
  }, [input, push])

  const submit = useCallback(() => {
    const raw = input
    if (!raw.trim()) return
    setHistory((current) => [...current, raw])
    setHistoryIndex(history.length + 1)
    setInput('')
    execute(raw)
  }, [execute, history.length, input])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setInput(history[next] ?? '')
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = Math.min(history.length, historyIndex + 1)
      setHistoryIndex(next)
      setInput(history[next] ?? '')
    } else if (event.key === 'Tab') {
      event.preventDefault()
      complete()
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      setEntries([])
    }
  }

  const peek = useMemo(() => "click or press ` to open", [])

  return (
    <div
      className={`wt-shell ${collapsed ? 'wt-shell--collapsed' : ''}`}
      onClick={collapsed ? focusInput : () => inputRef.current?.focus()}
      role={collapsed ? 'button' : undefined}
      aria-expanded={!collapsed}
      tabIndex={collapsed ? 0 : undefined}
    >
      <div className='wt-titlebar'>
        <div className='wt-lights'>
          <button type='button' className='wt-light wt-light--r' aria-label='close terminal' onClick={(event) => { event.stopPropagation(); setCollapsed(true) }} />
          <button type='button' className='wt-light wt-light--y' aria-label='minimize terminal' onClick={(event) => { event.stopPropagation(); setCollapsed(true) }} />
          <button type='button' className='wt-light wt-light--g' aria-label='expand terminal' onClick={(event) => { event.stopPropagation(); focusInput() }} />
        </div>
        {collapsed ? (
          <div className='wt-title wt-title--peek'><span className='wt-prompt-sigil'>$</span>{peek}<span className='wt-caret wt-caret--idle' /></div>
        ) : (
          <div className='wt-title'>{user}@{host} — terminal</div>
        )}
        <div className='wt-hint'>press <span className='wt-kbd'>`</span> to focus</div>
      </div>

      <div className='wt-body' ref={bodyRef} aria-hidden={collapsed}>
        <div className='wt-banner'>
          <span className='wt-banner-title'>WTERM V0.1 · SIA.SH</span>
          <span className='wt-banner-sub'>an interactive shell into this site — try help, whoami, or ls.</span>
        </div>
        {entries.length === 0 && (
          <div className='wt-entry wt-tone-muted'>type 'help' to get started · 'whoami' for the short version</div>
        )}
        {entries.map((entry, index) => entry.kind === 'input' ? (
          <div className='wt-entry' key={index}>
            <Prompt user={user} host={host} /><span className='wt-tone-fg'>{entry.raw}</span>
          </div>
        ) : (
          <div className='wt-entry' key={index}>
            {entry.lines.map((line, lineIndex) => <span className={`wt-line wt-tone-${line.tone || 'fg'}`} key={lineIndex}>{line.text}</span>)}
          </div>
        ))}
        <div className='wt-input-row'>
          <Prompt user={user} host={host} />
          <span className='wt-input-display'>
            <span className='wt-tone-fg'>{input}</span>
            <span className={`wt-caret ${focused ? '' : 'wt-caret--idle'}`} />
            {!input && !focused && <span className='wt-tone-muted wt-input-hint'>click or press <span className='wt-kbd'>`</span> then type <span className='wt-tone-primary'>help</span></span>}
            <input
              ref={inputRef}
              className='wt-input-hidden'
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              spellCheck={false}
              autoCapitalize='off'
              autoCorrect='off'
              aria-label='terminal input'
            />
          </span>
        </div>
      </div>
    </div>
  )
}

function Prompt({ user, host }: { user: string; host: string }) {
  return (
    <span className='wt-prompt'>
      <span className='wt-prompt-user'>{user}</span><span className='wt-prompt-at'>@</span><span className='wt-prompt-host'>{host}</span><span className='wt-prompt-cwd'> ~</span><span className='wt-prompt-sigil'>$</span>
    </span>
  )
}
