import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight, BarChart3,
  BookOpenCheck, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, FileSearch,
  Gauge, Info, LogOut, MessageSquareText, Plus, RefreshCw, Send,
  Settings2, ShieldCheck, Sparkles, Trash2, TriangleAlert, WandSparkles, X,
} from 'lucide-react';
import {
  getGetConversationQueryKey, getGetDashboardQueryKey, getGetSettingsQueryKey,
  getHealthCheckQueryKey, getListConversationsQueryKey, useClearConversationHistory,
  useCreateConversation, useDeleteConversation, useGetConversation, useGetDashboard,
  useGetSettings, useHealthCheck, useListConversations, useRegenerateAnswer,
  useRenameConversation, useSendMessage,
} from '@workspace/api-client-react';
import type { AnswerAnalysis, ChatMessage, ClaimCheck, Conversation } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';
import { ErrorBoundary } from '@/components/error-boundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: 1 } } });

const navigation = [
  { href: '/', label: 'Ask a question', icon: MessageSquareText },
  { href: '/history', label: 'History', icon: Clock3 },
  { href: '/dashboard', label: 'Overview', icon: BarChart3 },
  { href: '/about', label: 'About the checks', icon: BookOpenCheck },
  { href: '/settings', label: 'Configuration', icon: Settings2 },
];

function Brand() {
  return <Link href="/" className="brand-lockup" data-testid="link-home-brand">
    <span className="brand-mark"><ShieldCheck size={20} strokeWidth={1.8} /></span>
    <span><strong className="font-display">Verity</strong><small>AI, with receipts</small></span>
  </Link>;
}

function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 60_000 } });
  return <div className="app-shell">
    <aside className="side-nav">
      <Brand />
      <div className="nav-caption">WORKSPACE</div>
      <nav className="nav-stack">
        {navigation.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${location === href ? 'active' : ''}`} data-testid={`link-nav-${href === '/' ? 'ask' : href.slice(1)}`}>
          <Icon size={17} strokeWidth={1.8} /><span>{label}</span>{href === '/' && <span className="nav-shortcut">⌘ K</span>}
        </Link>)}
      </nav>
      <div className="sidebar-spacer" />
      <div className="trust-note">
        <span className="trust-icon"><CheckCircle2 size={16} /></span>
        <div><strong>Evidence, not certainty</strong><p>Every answer is a starting point for your own judgment.</p></div>
      </div>
      <div className="health-line" data-testid="status-api-health"><span className={`health-dot ${health.data ? 'online' : health.isError ? 'offline' : ''}`} />{health.isLoading ? 'Connecting to services' : health.data ? 'Services operational' : health.isError ? 'Service status unavailable' : 'Checking services'}</div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumb"><span>Verity</span><span className="crumb-slash">/</span><span className="crumb-current">{navigation.find(item => item.href === location)?.label ?? 'Workspace'}</span></div>
        <div className="topbar-right"><span className="evidence-indicator"><span /> evidence checks active</span><button className="btn btn-quiet" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); window.location.reload(); }} title="Log out"><LogOut size={14} /> Log out</button><div className="top-avatar">V</div></div>
      </header>
      <div className="content-wrap">{children}</div>
      <nav className="mobile-nav" aria-label="Main navigation">
        {navigation.filter(item => ['/', '/history', '/dashboard', '/settings'].includes(item.href)).map(({ href, label, icon: Icon }) =>
          <Link key={href} href={href} className={`nav-link ${location === href ? 'active' : ''}`} data-testid={`mobile-nav-${href === '/' ? 'ask' : href.slice(1)}`}><Icon size={18} /><span>{href === '/' ? 'Ask' : label}</span></Link>)}
      </nav>
    </main>
  </div>;
}

function PageHeading({ eyebrow, title, text, action }: { eyebrow: string; title: string; text: string; action?: ReactNode }) {
  return <div className="page-heading animate-in"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1><p className="page-intro">{text}</p></div>{action}</div>;
}

function LoadingPage() {
  return <div className="loading-page" role="status" aria-label="Loading"><div className="skeleton" style={{ width: 92, height: 10 }} /><div className="skeleton" style={{ width: 280, height: 38, marginTop: 17 }} /><div className="skeleton" style={{ width: '72%', height: 15, marginTop: 14 }} /><div className="skeleton" style={{ width: '100%', height: 170, marginTop: 35 }} /></div>;
}

function QueryError({ retry, message = 'We couldn’t load this view.' }: { retry: () => void; message?: string }) {
  return <div className="error-state surface"><span className="error-icon"><AlertCircle size={19} /></span><div><strong>{message}</strong><p>Check your connection, then try again.</p></div><button className="btn" onClick={retry} data-testid="button-retry"><RefreshCw size={14} /> Retry</button></div>;
}

function requestErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback;
  const record = error as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object') {
    const detail = (data as Record<string, unknown>).detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (detail && typeof detail === 'object') {
      const message = (detail as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message.replace(/^HTTP \d+ [^:]+:\s*/, '');
  }
  return fallback;
}

function EmptyState({ icon: Icon, title, text, children }: { icon: typeof MessageSquareText; title: string; text: string; children?: ReactNode }) {
  return <div className="empty-state surface"><div className="empty-orbit"><Icon size={23} strokeWidth={1.6} /></div><h3>{title}</h3><p>{text}</p>{children}</div>;
}

function AnswerChecks({ analysis }: { analysis: AnswerAnalysis }) {
  const [expanded, setExpanded] = useState(true);
  return <section className="checks-panel">
    <button className="checks-heading" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} data-testid="button-toggle-checks">
      <span className="checks-heading-icon"><FileSearch size={16} /></span>
      <span><strong>Evidence &amp; perspective</strong><small>{analysis.verificationAvailable ? `${analysis.claims.length} claims reviewed` : 'Evidence search unavailable'}</small></span>
      <ChevronDown className={expanded ? 'rotate-icon' : ''} size={16} />
    </button>
    {expanded && <div className="checks-content">
      {!analysis.verificationAvailable && <div className="notice notice-amber"><TriangleAlert size={15} /><span>Evidence unavailable for this response. Treat factual claims as unverified.</span></div>}
      {analysis.warnings.map((warning, i) => <div className="notice notice-amber" key={`${i}-${warning}`}><TriangleAlert size={15} /><span>{warning}</span></div>)}
      <div className="checks-subtitle">CLAIM REVIEW <span>{analysis.claims.length}</span></div>
      {analysis.claims.length ? analysis.claims.map((claim, i) => <ClaimRow claim={claim} key={`${i}-${claim.claim}`} />) : <p className="muted-copy compact">No distinct claims were available to review.</p>}
      <div className="bias-block">
        <div className="checks-subtitle">BIAS &amp; FRAMING</div>
        <div className="bias-summary"><span className={`bias-dot ${analysis.bias.detected ? 'bias-found' : ''}`} /><strong>{analysis.bias.detected ? 'Potential framing concerns' : 'No notable bias detected'}</strong></div>
        <p>{analysis.bias.explanation}</p>
        {analysis.bias.concerns.map((concern, i) => <div className="concern-row" key={`${i}-${concern.type}`}><span>{concern.type}</span><div><strong>{concern.text}</strong><p>{concern.explanation}</p></div></div>)}
      </div>
      {analysis.revisedAnswer && <div className="revised-block"><div className="revised-label"><Sparkles size={14} /> MORE CAREFUL VERSION</div><p>{analysis.revisedAnswer}</p>{analysis.changeExplanation && <small>{analysis.changeExplanation}</small>}</div>}
    </div>}
  </section>;
}

function ClaimRow({ claim }: { claim: ClaimCheck }) {
  const [open, setOpen] = useState(false);
  const tone = claim.status === 'SUPPORTED' ? 'status-supported' : claim.status === 'CONTRADICTED' ? 'status-contradicted' : 'status-insufficient';
  const label = claim.status === 'SUPPORTED' ? 'Supported' : claim.status === 'CONTRADICTED' ? 'Contradicted' : 'Unclear';
  return <div className="claim-row">
    <button className="claim-button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid={`button-claim-${claim.status.toLowerCase()}`}>
      <span className="claim-label"><span className={`status-pill ${tone}`}>{claim.status === 'SUPPORTED' ? <Check size={11} /> : claim.status === 'CONTRADICTED' ? <X size={11} /> : <CircleHelp size={11} />}{label}</span><span className="claim-text">{claim.claim}</span></span><ChevronDown size={14} className={open ? 'rotate-icon' : ''} />
    </button>
    {open && <div className="claim-detail"><p>{claim.explanation}</p>{claim.evidence.length > 0 && <div className="source-list">{claim.evidence.map((source, i) => <a key={`${source.url}-${i}`} href={source.url} target="_blank" rel="noreferrer" className="source-link"><span><strong>{source.title}</strong><small>{source.excerpt}</small></span><ArrowUpRight size={13} /></a>)}</div>}</div>}
  </div>;
}

function MessageItem({ message, onRegenerate, regenerating }: { message: ChatMessage; onRegenerate?: (id: string) => void; regenerating?: boolean }) {
  if (message.role === 'user') return <div className="message-user animate-in"><div className="message-meta"><span className="user-avatar">Y</span><span>You</span><time>{formatTime(message.createdAt)}</time></div><div className="user-bubble">{message.content}</div></div>;
  const analysis = message.analysis;
  return <div className="assistant-message animate-in">
    <div className="message-meta"><span className="assistant-avatar"><Sparkles size={14} /></span><span>Verity answer</span><time>{formatTime(message.createdAt)}</time>{analysis?.verificationAvailable && <span className="verified-mini"><ShieldCheck size={12} /> checked</span>}</div>
    <div className="assistant-card"><p className="answer-text">{message.content}</p>
      {analysis && <><div className="answer-footer"><span className="answer-note"><Info size={13} /> AI-generated. Review sources before relying on it.</span>{onRegenerate && <button className="btn btn-quiet" onClick={() => onRegenerate(message.id)} disabled={regenerating} data-testid={`button-regenerate-${message.id}`}><RefreshCw size={13} className={regenerating ? 'spin' : ''} /> {regenerating ? 'Rechecking' : 'Recheck answer'}</button>}</div><AnswerChecks analysis={analysis} /></>}
    </div>
  </div>;
}

function HomePage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const conversations = useListConversations({ query: { queryKey: getListConversationsQueryKey() } });
  const [conversationId, setConversationId] = useState(() => new URLSearchParams(window.location.search).get('c') ?? '');
  const [prompt, setPrompt] = useState('');
  const [failedRequest, setFailedRequest] = useState<{ conversationId: string; content: string } | null>(null);
  const detail = useGetConversation(conversationId, { query: { queryKey: getGetConversationQueryKey(conversationId), enabled: Boolean(conversationId) } });
  const createConversation = useCreateConversation();
  const sendMessage = useSendMessage();
  const regenerateAnswer = useRegenerateAnswer();
  const busy = createConversation.isPending || sendMessage.isPending || regenerateAnswer.isPending;
  const messages = detail.data?.messages ?? [];
  const pendingConversation = createConversation.isPending;
  useEffect(() => { if (conversationId) setLocation(`/?c=${encodeURIComponent(conversationId)}`, { replace: true }); }, [conversationId, setLocation]);

  const refreshAfterSend = (id: string) => {
    queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  };
  const sendToConversation = (id: string, content: string) => {
    sendMessage.mutate(
      { conversationId: id, data: { content } },
      {
        onSuccess: () => {
          setFailedRequest(null);
          refreshAfterSend(id);
        },
        onError: () => {
          setFailedRequest({ conversationId: id, content });
          setPrompt(content);
        },
      },
    );
  };
  const retryFailedRequest = () => {
    if (!failedRequest || busy || prompt.trim() !== failedRequest.content) return;
    const retry = failedRequest;
    setFailedRequest(null);
    setPrompt('');
    sendToConversation(retry.conversationId, retry.content);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content = prompt.trim();
    if (!content || busy) return;
    sendMessage.reset();
    createConversation.reset();
    regenerateAnswer.reset();
    setFailedRequest(null);
    setPrompt('');
    if (conversationId) sendToConversation(conversationId, content);
    else createConversation.mutate({ data: { title: content.slice(0, 72) || 'New conversation' } }, {
      onSuccess: conversation => { setConversationId(conversation.id); sendToConversation(conversation.id, content); },
      onError: () => setPrompt(content),
    });
  };
  const regenerate = (questionId: string) => {
    if (!conversationId || busy) return;
    regenerateAnswer.mutate({ conversationId, data: { questionId } }, { onSuccess: () => refreshAfterSend(conversationId) });
  };
  const startFresh = () => {
    setConversationId('');
    setPrompt('');
    setFailedRequest(null);
    sendMessage.reset();
    createConversation.reset();
    regenerateAnswer.reset();
    setLocation('/');
  };
  const examplePrompts = ['What makes a clinical study reliable?', 'How do heat pumps work in cold climates?', 'What are the trade-offs of carbon offsets?'];
  const requestError = sendMessage.isError
    ? sendMessage.error
    : createConversation.isError
      ? createConversation.error
      : regenerateAnswer.error;
  const canRetryMessage = sendMessage.isError
    && failedRequest !== null
    && prompt.trim() === failedRequest.content;
  return <>
    <div className="chat-topline"><div><div className="eyebrow"><span className="eyebrow-dot" /> A CLEARER KIND OF ANSWER</div><h1 className="hero-title">{messages.length ? 'Keep asking.' : <>Good questions<br /><em>deserve good evidence.</em></>}</h1><p className="page-intro hero-intro">Ask anything. See what holds up, where perspective may be missing, and what remains uncertain.</p></div>
      <button className="btn new-chat-button" onClick={startFresh} data-testid="button-new-conversation"><Plus size={15} /> New conversation</button></div>
    <div className="chat-grid">
      <section className="chat-column">
        {detail.isLoading && conversationId && <div className="message-loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>}
        {detail.isError && conversationId && <QueryError retry={() => detail.refetch()} message="This conversation couldn’t be opened." />}
        {!detail.isLoading && !detail.isError && messages.length === 0 && <div className="welcome-panel animate-in"><div className="welcome-badge"><WandSparkles size={17} /> Let’s think it through</div><h2>Start with a question.<br /><span>Leave room for nuance.</span></h2><p>Verity brings Gemini’s answer together with claim-level evidence checks and a read on framing.</p><div className="prompt-suggestions">{examplePrompts.map((example, i) => <button className="suggestion" key={example} onClick={() => setPrompt(example)} data-testid={`button-suggestion-${i}`}><span>{example}</span><ArrowRight size={14} /></button>)}</div></div>}
        {messages.map((message, i) => <MessageItem key={message.id} message={message} onRegenerate={message.role === 'assistant' && message.analysis ? () => regenerate(messages[i - 1]?.id ?? '') : undefined} regenerating={regenerateAnswer.isPending && i === messages.length - 1} />)}
        {sendMessage.isPending && <div className="thinking-card"><span className="thinking-orb"><Sparkles size={15} /></span><div><strong>Working through your question</strong><p>Checking claims and looking for another angle…</p></div><div className="thinking-bars"><i /><i /><i /></div></div>}
        {(sendMessage.isError || createConversation.isError || regenerateAnswer.isError) && <div className="notice notice-red" role="alert"><AlertCircle size={15} /><span>{requestErrorMessage(requestError, 'That request didn’t go through.')}{sendMessage.isError ? ' Your question is still in the composer.' : ''}</span>{canRetryMessage && <button className="notice-retry" type="button" onClick={retryFailedRequest} disabled={busy} data-testid="button-retry-send" aria-label="Retry sending your question">Retry</button>}</div>}
        <form className="composer surface" onSubmit={submit}>
          <label htmlFor="prompt-input" className="sr-only">Ask Verity a question</label><textarea id="prompt-input" className="composer-input" rows={2} maxLength={10000} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit(); } }} placeholder="Ask a question — the more specific, the better…" data-testid="input-question" />
          <div className="composer-bottom"><span className="composer-hint"><ShieldCheck size={13} /> Evidence checks included <span className="hint-divider">·</span> Shift + Enter for a new line</span><div className="composer-actions"><span className="char-count">{prompt.length}/10,000</span><button className="send-button" type="submit" disabled={!prompt.trim() || busy} aria-label="Send question" data-testid="button-send-question">{busy ? <span className="button-loader" /> : <Send size={16} />}</button></div></div>
        </form>
        <div className="under-composer">Verity can make mistakes. Use the evidence trail to decide what to trust.</div>
      </section>
      <aside className="chat-aside">
        <div className="aside-card protocol-card"><div className="aside-card-head"><span className="aside-icon blue"><ShieldCheck size={16} /></span><span>OUR CHECKING PROCESS</span></div><div className="protocol-step"><b>01</b><div><strong>Answer</strong><p>Gemini responds to your question.</p></div></div><div className="protocol-step"><b>02</b><div><strong>Find evidence</strong><p>Key claims are checked against sources.</p></div></div><div className="protocol-step"><b>03</b><div><strong>Look for framing</strong><p>Potential bias and uncertainty are surfaced.</p></div></div></div>
        <div className="aside-card recent-card"><div className="aside-card-head"><span className="aside-icon teal"><Clock3 size={15} /></span><span>RECENT THREADS</span><Link href="/history" className="aside-more" data-testid="link-view-history">View all <ArrowRight size={12} /></Link></div>
          {conversations.isLoading ? <div className="recent-skeleton"><div className="skeleton" /><div className="skeleton" /></div> : conversations.isError ? <button className="inline-retry" onClick={() => conversations.refetch()}>Couldn’t load threads. Retry</button> : conversations.data?.length ? conversations.data.slice(0, 4).map(conversation => <button className={`recent-thread ${conversation.id === conversationId ? 'selected' : ''}`} key={conversation.id} onClick={() => setConversationId(conversation.id)} data-testid={`button-open-thread-${conversation.id}`}><span>{conversation.title}</span><small>{formatDate(conversation.updatedAt)}</small></button>) : <p className="recent-empty">Your conversations will appear here.</p>}
        </div>
        <div className="privacy-note"><Info size={14} /><span>Your conversations are private to this session. No sign-in required.</span></div>
      </aside>
    </div>
  </>;
}

function HistoryPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const list = useListConversations({ query: { queryKey: getListConversationsQueryKey() } });
  const rename = useRenameConversation();
  const remove = useDeleteConversation();
  const clear = useClearConversationHistory();
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const filtered = useMemo(() => (list.data ?? []).filter(c => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [list.data, search]);
  const refresh = () => { queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); };
  const handleRename = (conversation: Conversation) => {
    const title = window.prompt('Choose a new conversation title', conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    setBusyId(conversation.id); setNotice('');
    rename.mutate({ conversationId: conversation.id, data: { title } }, { onSuccess: () => { refresh(); setNotice('Conversation renamed.'); }, onError: () => setNotice('Could not rename this conversation.'), onSettled: () => setBusyId('') });
  };
  const handleDelete = (conversation: Conversation) => {
    if (!window.confirm(`Delete “${conversation.title}”? This can’t be undone.`)) return;
    setBusyId(conversation.id); setNotice('');
    remove.mutate({ conversationId: conversation.id }, { onSuccess: () => { refresh(); setNotice('Conversation deleted.'); }, onError: () => setNotice('Could not delete this conversation.'), onSettled: () => setBusyId('') });
  };
  const handleClear = () => {
    if (!list.data?.length || !window.confirm(`Delete all ${list.data.length} conversations? This can’t be undone.`)) return;
    clear.mutate(undefined, { onSuccess: () => { refresh(); setNotice('All conversations cleared.'); }, onError: () => setNotice('Could not clear conversation history.') });
  };
  return <>
    <PageHeading eyebrow="YOUR WORKSPACE" title="Conversation history" text="Pick up where you left off. Your threads stay available in this session." action={<button className="btn btn-danger" onClick={handleClear} disabled={!list.data?.length || clear.isPending} data-testid="button-clear-history"><Trash2 size={14} /> {clear.isPending ? 'Clearing…' : 'Clear history'}</button>} />
    <div className="history-toolbar"><div className="search-box"><FileSearch size={16} /><input type="search" className="search-input" placeholder="Find a conversation…" value={search} onChange={e => setSearch(e.target.value)} data-testid="input-search-history" />{search && <button className="icon-clear" aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</div><span className="result-count">{list.data?.length ?? 0} {list.data?.length === 1 ? 'conversation' : 'conversations'}</span></div>
    {notice && <div className="notice notice-blue" role="status"><CheckCircle2 size={15} />{notice}<button className="notice-dismiss" onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button></div>}
    {list.isLoading && <LoadingPage />}
    {list.isError && <QueryError retry={() => list.refetch()} message="Conversation history couldn’t be loaded." />}
    {list.data && list.data.length === 0 && <EmptyState icon={MessageSquareText} title="Nothing here yet" text="When you ask Verity a question, the conversation will be saved here." />}
    {list.data?.length !== 0 && list.data && filtered.length === 0 && <EmptyState icon={FileSearch} title="No matching conversations" text="Try another search term, or clear the search to see every thread." />}
    {filtered.length > 0 && <div className="history-list">{filtered.map((conversation, i) => <article key={conversation.id} className="history-row surface animate-in" style={{ animationDelay: `${i * 35}ms` }}>
      <span className="history-row-icon"><MessageSquareText size={17} /></span><div className="history-row-body"><Link href={`/?c=${encodeURIComponent(conversation.id)}`} className="history-title" data-testid={`link-conversation-${conversation.id}`}>{conversation.title}</Link><div className="history-meta"><span>Updated {formatDate(conversation.updatedAt)}</span><span className="meta-dot" />Started {formatDate(conversation.createdAt)}</div></div>
      <div className="history-actions"><button className="btn btn-quiet" onClick={() => handleRename(conversation)} disabled={busyId === conversation.id} data-testid={`button-rename-${conversation.id}`} aria-label={`Rename ${conversation.title}`}>Rename</button><button className="btn btn-quiet delete-action" onClick={() => handleDelete(conversation)} disabled={busyId === conversation.id} data-testid={`button-delete-${conversation.id}`} aria-label={`Delete ${conversation.title}`}><Trash2 size={14} /></button><Link href={`/?c=${encodeURIComponent(conversation.id)}`} className="btn btn-open" data-testid={`button-reopen-${conversation.id}`}>Open <ArrowRight size={13} /></Link></div>
    </article>)}</div>}
    <div className="history-footnote"><ShieldCheck size={14} /> Conversation history is scoped to this browser session.</div>
  </>;
}

function DashboardPage() {
  const stats = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  const list = useListConversations({ query: { queryKey: getListConversationsQueryKey() } });
  const tiles = stats.data ? [
    { label: 'Questions asked', value: stats.data.totalQuestions, icon: MessageSquareText, tint: 'blue', detail: 'Across your conversations' },
    { label: 'Responses analyzed', value: stats.data.analyzedResponses, icon: FileSearch, tint: 'teal', detail: 'With evidence and framing checks' },
    { label: 'Potential hallucinations', value: stats.data.potentialHallucinations, icon: CircleHelp, tint: 'gold', detail: 'Claims needing extra scrutiny' },
    { label: 'Potential bias issues', value: stats.data.potentialBiasIssues, icon: Gauge, tint: 'rose', detail: 'Responses with framing concerns' },
    { label: 'Responses revised', value: stats.data.revisedResponses, icon: RefreshCw, tint: 'violet', detail: 'With a more careful alternative' },
  ] : [];
  return <>
    <PageHeading eyebrow="A SESSION-LEVEL VIEW" title="Your evidence ledger" text="A transparent count of what’s been asked and checked. Every number comes from your stored conversations." />
    {stats.isLoading ? <div className="stat-grid">{Array.from({ length: 5 }, (_, i) => <div className="stat-tile surface" key={i}><div className="skeleton" style={{ width: 38, height: 38, borderRadius: 12 }} /><div className="skeleton" style={{ height: 34, width: 78, marginTop: 22 }} /><div className="skeleton" style={{ height: 13, width: 130, marginTop: 12 }} /></div>)}</div> :
      stats.isError ? <QueryError retry={() => stats.refetch()} message="Your session statistics couldn’t be loaded." /> :
      stats.data && <><div className="stat-grid">{tiles.map(({ label, value, icon: Icon, tint, detail }, i) => <div className={`stat-tile surface animate-in delay-${Math.min(i + 1, 3)}`} key={label} data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div className={`stat-icon ${tint}`}><Icon size={18} /></div><div className="stat-number">{value.toLocaleString()}</div><h3>{label}</h3><p>{detail}</p></div>)}</div>
        <div className="dashboard-lower">
          <section className="ledger-card surface"><div className="section-head"><div><div className="eyebrow">RECENT ACTIVITY</div><h2>Conversations</h2></div><Link href="/history" className="text-link" data-testid="link-dashboard-history">All history <ArrowRight size={14} /></Link></div>
            {list.isLoading ? <div className="recent-skeleton"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : list.isError ? <div className="inline-error">Conversation list unavailable. <button onClick={() => list.refetch()}>Retry</button></div> : list.data?.length ? <div className="dashboard-conversations">{list.data.slice(0, 5).map(c => <Link key={c.id} href={`/?c=${encodeURIComponent(c.id)}`} className="dashboard-conversation" data-testid={`dashboard-conversation-${c.id}`}><span className="conversation-dot"><MessageSquareText size={14} /></span><span className="conversation-title">{c.title}</span><time>{formatDate(c.updatedAt)}</time><ArrowRight size={14} /></Link>)}</div> : <p className="muted-copy">No conversations yet. Your session totals will grow as you ask questions.</p>}
          </section>
          <aside className="ledger-note"><div className="note-symbol"><Activity size={18} /></div><div className="eyebrow">READING THE NUMBERS</div><h3>Signals, not verdicts.</h3><p>Potential hallucinations and bias flags are prompts to inspect a response—not a definitive judgment of truth or intent.</p><Link href="/about" className="text-link" data-testid="link-learn-method">How the checks work <ArrowRight size={13} /></Link></aside>
        </div></>}
  </>;
}

function AboutPage() {
  return <>
    <PageHeading eyebrow="A MORE HONEST INTERFACE" title="Useful answers. Visible limits." text="Verity pairs Gemini’s helpfulness with a clear view of evidence, uncertainty, and perspective—so you can make a better-informed call." />
    <div className="about-hero surface"><div className="about-hero-copy"><div className="eyebrow">WHY VERITY EXISTS</div><h2>Confidence is not<br />the same as <em>being right.</em></h2><p>AI can make a plausible answer sound settled. Verity makes the reasoning around that answer easier to inspect.</p></div><div className="about-orbit"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-core"><ShieldCheck size={30} /></div><span className="orbit-chip chip-source"><FileSearch size={13} /> Evidence</span><span className="orbit-chip chip-bias"><Gauge size={13} /> Perspective</span><span className="orbit-chip chip-uncertainty"><CircleHelp size={13} /> Uncertainty</span></div></div>
    <div className="about-section-title"><div className="eyebrow">THREE LAYERS OF CONTEXT</div><h2>Read the answer. Then read around it.</h2></div>
    <div className="method-grid"><article className="method-card"><span className="method-index">01 / EVIDENCE</span><div className="method-icon"><FileSearch size={19} /></div><h3>Claim-level checks</h3><p>Factual claims are compared with available search evidence. Each check shows its explanation and the sources used, when available.</p><div className="method-caption"><CheckCircle2 size={13} /> Sources you can open</div></article><article className="method-card"><span className="method-index">02 / PERSPECTIVE</span><div className="method-icon teal"><Gauge size={19} /></div><h3>Bias and framing</h3><p>A separate pass looks for potentially loaded framing, missing context, or one-sided assumptions—not a score for whether an answer is “biased.”</p><div className="method-caption"><CheckCircle2 size={13} /> Concerns explained in context</div></article><article className="method-card"><span className="method-index">03 / REVISION</span><div className="method-icon gold"><WandSparkles size={19} /></div><h3>A more careful version</h3><p>When it helps, see a revised answer alongside what changed, so uncertainty and unsupported statements are easier to spot.</p><div className="method-caption"><CheckCircle2 size={13} /> Changes are made visible</div></article></div>
    <div className="limits-card"><div className="limits-mark"><TriangleAlert size={19} /></div><div><div className="eyebrow">IMPORTANT LIMITATIONS</div><h2>Checks can be wrong, too.</h2><p>Evidence search may be incomplete or unavailable. Sources can be outdated, claim matching can miss nuance, and bias analysis is itself an imperfect model judgment. A supported claim is not proof; a concern is not a verdict. For high-stakes decisions, consult qualified people and primary sources.</p></div></div>
    <div className="about-end"><span className="about-end-line" /><p>Designed to support judgment, never replace it.</p><Link href="/" className="btn btn-primary" data-testid="button-try-verity">Ask a question <ArrowRight size={14} /></Link></div>
  </>;
}

function SettingsPage() {
  const settings = useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
  return <>
    <PageHeading eyebrow="SERVICE STATUS" title="Configuration" text="A read-only view of the models and services available to this workspace. Credentials are never displayed here." />
    {settings.isLoading ? <LoadingPage /> : settings.isError ? <QueryError retry={() => settings.refetch()} message="Configuration status couldn’t be loaded." /> : settings.data && <>
      <div className="settings-status-banner surface"><div className="settings-banner-symbol"><Activity size={19} /></div><div><div className="eyebrow">CURRENT SETUP</div><h2>Service availability</h2><p>Status is reported by the application server. No keys or secrets are exposed.</p></div><span className="read-only-tag">READ ONLY</span></div>
      <div className="settings-grid">
        <section className="settings-card surface"><div className="settings-card-head"><span className="settings-icon gemini"><Sparkles size={17} /></span><div><div className="eyebrow">ANSWER PROVIDER</div><h3>Gemini</h3></div><StatusBadge available={settings.data.geminiConfigured} yes="Configured" no="Not configured" /></div><div className="settings-field"><span>Provider</span><strong>{settings.data.provider || 'Not reported'}</strong></div><div className="settings-field"><span>Model</span><strong className="mono-value">{settings.data.model || 'Not reported'}</strong></div><p className="settings-caption">Used to generate original and revised answers.</p></section>
        <section className="settings-card surface"><div className="settings-card-head"><span className="settings-icon search"><FileSearch size={17} /></span><div><div className="eyebrow">EVIDENCE SERVICE</div><h3>Search</h3></div><StatusBadge available={settings.data.evidenceSearchAvailable} yes="Available" no="Unavailable" /></div><div className="settings-field"><span>Provider</span><strong>{settings.data.evidenceSearchProvider || 'Not reported'}</strong></div><p className="settings-caption">Search results provide supporting context for claim-level checks.</p></section>
      </div>
      <section className="env-card surface"><div className="section-head"><div><div className="eyebrow">SERVER ENVIRONMENT</div><h2>Required configuration</h2></div><span className="safe-label"><ShieldCheck size={13} /> Names only · never values</span></div><p className="muted-copy">These variable names indicate which integrations the server expects. Their values are kept private.</p><div className="env-list">{settings.data.requiredEnvironmentVariables.length ? settings.data.requiredEnvironmentVariables.map((variable, i) => <div className="env-item" key={`${variable}-${i}`}><span className="env-key"><span className={`env-dot ${settings.data.geminiConfigured || settings.data.evidenceSearchAvailable ? 'configured' : ''}`} />{variable}</span><span className="env-state">Secret value hidden</span></div>) : <div className="env-empty"><CheckCircle2 size={15} /> No required environment variable names were reported.</div>}</div></section>
      <div className="settings-footer"><Info size={14} /> Configuration can only be changed by the application operator.</div>
    </>}
  </>;
}

function StatusBadge({ available, yes, no }: { available: boolean; yes: string; no: string }) {
  return <span className={`config-badge ${available ? 'config-on' : 'config-off'}`}><span />{available ? yes : no}</span>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <Layout><RoutedErrorBoundary><Switch>
    <Route path="/" component={HomePage} />
    <Route path="/history" component={HistoryPage} />
    <Route path="/dashboard" component={DashboardPage} />
    <Route path="/about" component={AboutPage} />
    <Route path="/settings" component={SettingsPage} />
    <Route component={NotFound} />
  </Switch></RoutedErrorBoundary></Layout>;
}

type AuthUser = { id: string; name: string; email: string };

function AuthGate() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(async response => response.ok ? response.json() : Promise.reject(new Error('Could not check your login status.')))
      .then(data => { if (data.authenticated && data.user) setUser(data.user as AuthUser); })
      .catch(() => setError('Cannot connect to Verity’s backend. Start the backend service and try again.'))
      .finally(() => setChecking(false));
  }, []);

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'signup' ? { name, email, password } : { email, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not complete authentication.');
      setUser(data.user as AuthUser);
      queryClient.clear();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  if (checking) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--background, #f7f8fa)', color: 'var(--foreground, #1b2430)' }}>Checking your Verity account…</div>;
  if (user) return <Router />;
  return <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(320px, .9fr)', background: '#f7f8fa', color: '#17202b' }}>
    <section style={{ padding: 'clamp(28px, 7vw, 90px)', display: 'flex', flexDirection: 'column', justifyContent: 'center', background: '#142a2a', color: '#f5f8f6' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 55 }}><span style={{ width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: '#b8e4cb', color: '#163b32' }}><ShieldCheck size={23} /></span><span><strong style={{ fontSize: 26 }}>Verity</strong><div style={{ opacity: .7, fontSize: 13 }}>AI, with receipts</div></span></div>
      <div style={{ color: '#b8e4cb', textTransform: 'uppercase', letterSpacing: 2, fontSize: 12, fontWeight: 700 }}>Responsible AI workspace</div>
      <h1 style={{ fontSize: 'clamp(34px, 4.2vw, 58px)', lineHeight: 1.08, maxWidth: 570, margin: '18px 0' }}>Answers deserve evidence. Not blind trust.</h1>
      <p style={{ maxWidth: 490, color: '#d1ded9', fontSize: 16, lineHeight: 1.8 }}>Explore AI responses with factual claim checks, evidence context, and bias-awareness tools—inside your own account.</p>
      <div style={{ display: 'grid', gap: 14, marginTop: 35, color: '#e1ece7' }}><div>✓ Evidence and claim review</div><div>✓ Bias and framing checks</div><div>✓ Private account-based chat history</div></div>
    </section>
    <section style={{ display: 'grid', placeItems: 'center', padding: 24 }}><form onSubmit={submitAuth} style={{ width: 'min(100%, 410px)', background: '#fff', border: '1px solid #e4e8e6', borderRadius: 22, padding: 'clamp(24px, 4vw, 40px)', boxShadow: '0 18px 55px #10202012' }}>
      <div style={{ color: '#427b65', fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>{mode === 'login' ? 'Welcome back' : 'Create your account'}</div>
      <h2 style={{ margin: '9px 0 8px', fontSize: 29 }}>{mode === 'login' ? 'Log in to Verity' : 'Join Verity'}</h2>
      <p style={{ margin: '0 0 25px', color: '#68736f', lineHeight: 1.6 }}>{mode === 'login' ? 'Continue your responsible AI workspace.' : 'Create an account to keep your conversations tied to you.'}</p>
      {mode === 'signup' && <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 15 }}>Full name<input required autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="Your name" style={authInputStyle} /></label>}
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 15 }}>Email address<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} placeholder="you@example.com" style={authInputStyle} /></label>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 17 }}>Password<input required type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} minLength={mode === 'signup' ? 8 : 1} maxLength={128} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} style={authInputStyle} /></label>
      {error && <div role="alert" style={{ padding: 12, marginBottom: 16, borderRadius: 10, background: '#fff0ed', color: '#9b3023', fontSize: 13, lineHeight: 1.5 }}>{error}</div>}
      <button type="submit" disabled={busy} style={{ width: '100%', border: 0, borderRadius: 11, padding: '13px 16px', background: busy ? '#9bb8aa' : '#1d5141', color: '#fff', fontWeight: 700, cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
      <p style={{ textAlign: 'center', margin: '22px 0 0', color: '#65716c', fontSize: 14 }}>{mode === 'login' ? 'New to Verity?' : 'Already have an account?'} <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }} style={{ border: 0, background: 'none', color: '#1d6a50', fontWeight: 700, cursor: 'pointer' }}>{mode === 'login' ? 'Create account' : 'Log in'}</button></p>
      <p style={{ margin: '18px 0 0', color: '#87918c', fontSize: 11, lineHeight: 1.5, textAlign: 'center' }}>Passwords are stored as salted PBKDF2-SHA256 hashes, not plain text.</p>
    </form></section>
  </div>;
}

const authInputStyle: CSSProperties = { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 7, border: '1px solid #dce3df', borderRadius: 10, padding: '12px 13px', outlineColor: '#4d9277', fontSize: 14, background: '#fff', color: '#17202b' };

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><AuthGate /><Toaster /></TooltipProvider></QueryClientProvider>;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }).format(date);
}
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

export default App;
