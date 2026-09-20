import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import './terminal.css'

type Line = { tone?: 'fg' | 'muted' | 'primary' | 'ok' | 'err'; text: string }
type Entry = { kind: 'input'; raw: string } | { kind: 'output'; lines: Line[] }

const pages: Record<string, string> = {
  home: '/',
  blog: '/blog',
  notes: '/notes',
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
  const [collapsed, setCollapsed] = useState(true)
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
        { tone: 'primary', text: '可以试试这些命令：' },
        { text: '  help                 查看可用命令' },
        { text: '  whoami / about       认识一下我' },
        { text: '  ls                   查看网站栏目' },
        { text: '  cd <page>            前往一个栏目' },
        { text: '  open <page>          打开一个栏目' },
        { text: '  github               打开 GitHub 主页' },
        { text: '  status               查看站点信息' },
        { text: '  theme                切换明暗主题' },
        { text: '  clear                清空终端记录' }
      ])
      return
    }
    if (command === 'whoami' || command === 'about') {
      push([
        { tone: 'primary', text: 'Sia' },
        { text: '北京邮电大学 · 电子类研究生' },
        { text: 'AI Agent · LLM Systems · Backend Engineering' },
        { tone: 'muted', text: '在做 SkillClaw Summarizer GRPO · 目前在深势科技实习。' }
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
        { tone: 'ok', text: '● SIA’S SPACE' },
        { text: 'Vercel · Astro · https://siaspace.vercel.app' }
      ])
      return
    }
    if (command === 'theme') {
      document.querySelector<HTMLButtonElement>('#toggleDarkMode')?.click()
      push([{ tone: 'ok', text: '已切换主题' }])
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
      { tone: 'err', text: `没有这个命令： ${command}` },
      { tone: 'muted', text: "输入 help 查看可用命令" }
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

  const peek = useMemo(() => "点击或按 ` 打开终端", [])

  return (
    <div
      className={`wt-shell ${collapsed ? 'wt-shell--collapsed' : ''}`}
      onClick={collapsed ? focusInput : () => inputRef.current?.focus()}
      role={collapsed ? 'button' : undefined}
      onKeyDown={collapsed ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusInput() } } : undefined}
      aria-expanded={!collapsed}
      tabIndex={collapsed ? 0 : undefined}
    >
      <div className='wt-titlebar'>
        <div className='wt-lights'>
          <button type='button' className='wt-light wt-light--r' aria-label='收起终端' onClick={(event) => { event.stopPropagation(); setCollapsed(true) }} />
          <button type='button' className='wt-light wt-light--y' aria-label='最小化终端' onClick={(event) => { event.stopPropagation(); setCollapsed(true) }} />
          <button type='button' className='wt-light wt-light--g' aria-label='展开终端' onClick={(event) => { event.stopPropagation(); focusInput() }} />
        </div>
        {collapsed ? (
          <div className='wt-title wt-title--peek'><span className='wt-prompt-sigil'>$</span>{peek}<span className='wt-caret wt-caret--idle' /></div>
        ) : (
          <div className='wt-title'>{user}@{host} — terminal</div>
        )}
        <div className='wt-hint'>按 <span className='wt-kbd'>`</span> 输入</div>
      </div>

      <div className='wt-body' ref={bodyRef} aria-hidden={collapsed} inert={collapsed}>
        <div className='wt-banner'>
          <span className='wt-banner-title'>WTERM V0.1 · SIA.SH</span>
          <span className='wt-banner-sub'>换个方式逛逛：help 看命令，whoami 看介绍，ls 看栏目。</span>
        </div>
        {entries.length === 0 && (
          <div className='wt-entry wt-tone-muted'>输入 help 开始，或用 whoami 认识一下我</div>
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
            {!input && !focused && <span className='wt-tone-muted wt-input-hint'>输入 <span className='wt-tone-primary'>help</span> 开始</span>}
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
              aria-label='终端命令输入'
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
