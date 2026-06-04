import { useState, useEffect, useRef, useCallback } from "react";
import Icon from "@/components/ui/icon";

const PROXY_URL = "https://functions.poehali.dev/5b399dfe-b797-42bb-9de8-49baab5c46d5";

type Tab = "login" | "messages" | "status" | "settings";
type ConnStatus = "offline" | "connecting" | "online" | "error";

interface IrcMessage {
  id: number;
  raw: string;
  time: string;
  type: "in" | "out" | "system" | "error";
  parsed?: { command: string; params: string; prefix?: string };
}

interface Settings {
  server: string;
  port: string;
  nick: string;
  ident: string;
}

const DEFAULT_SETTINGS: Settings = {
  server: "galaxy.mobstudio.ru",
  port: "6667",
  nick: "GALA",
  ident: "352",
};

function parseIRC(raw: string) {
  const line = raw.trim();
  let prefix = "";
  let rest = line;
  if (line.startsWith(":")) {
    const idx = line.indexOf(" ");
    prefix = line.slice(1, idx);
    rest = line.slice(idx + 1);
  }
  const parts = rest.split(" ");
  return { command: parts[0], params: parts.slice(1).join(" "), prefix };
}

function getCommandColor(cmd: string): string {
  const map: Record<string, string> = {
    "999": "#39ff14", "REGISTER": "#00ffd5", "USER": "#00ffd5",
    "HAAAPSI": "#bf5fff", "RECOVER": "#bf5fff", "RECOVERY": "#bf5fff",
    "DOMAINS": "#ff8c00", "ADDONS": "#888", "MYADDONS": "#888",
    "PHONE": "#ff8c00", "JOIN": "#00ffd5", "FWLISTVER": "#888",
    "IDENT": "#00ffd5", "PING": "#ff8c00", "PONG": "#ff8c00", "ERROR": "#ff2e2e",
  };
  return map[cmd] || "#aaa";
}

async function proxyCall(body: object): Promise<Record<string, unknown>> {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

let msgIdCounter = 0;

export default function Index() {
  const [tab, setTab] = useState<Tab>("login");
  const [status, setStatus] = useState<ConnStatus>("offline");
  const [messages, setMessages] = useState<IrcMessage[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [inputRecovery, setInputRecovery] = useState("");
  const [inputUser, setInputUser] = useState("");
  const [inputPass, setInputPass] = useState("");
  const [connectedAt, setConnectedAt] = useState<Date | null>(null);
  const [bytesSent, setBytesSent] = useState(0);
  const [bytesRecv, setBytesRecv] = useState(0);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [sendInput, setSendInput] = useState("");
  const [uptime, setUptime] = useState(0);

  const sessionIdRef = useRef<string>("");
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptimeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const addMessage = useCallback((raw: string, type: IrcMessage["type"]) => {
    const time = new Date().toTimeString().slice(0, 8);
    const parsed = parseIRC(raw);
    setMessages((prev) => [...prev.slice(-500), { id: msgIdCounter++, raw, time, type, parsed }]);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    if (uptimeIntervalRef.current) { clearInterval(uptimeIntervalRef.current); uptimeIntervalRef.current = null; }
  }, []);

  const disconnect = useCallback(async () => {
    stopPolling();
    if (sessionIdRef.current) {
      proxyCall({ action: "disconnect", session_id: sessionIdRef.current }).catch(() => {});
      sessionIdRef.current = "";
    }
    setStatus("offline");
    setConnectedAt(null);
    setPingMs(null);
    setUptime(0);
    addMessage("--- Отключено от сервера ---", "system");
  }, [addMessage, stopPolling]);

  const processLines = useCallback((lines: string[]) => {
    lines.forEach((line) => {
      setBytesRecv((b) => b + line.length);
      if (line.startsWith("PING")) {
        proxyCall({ action: "send", session_id: sessionIdRef.current, commands: [`PONG ${line.slice(5)}`] }).catch(() => {});
      }
      addMessage(line, "in");
    });
  }, [addMessage]);

  const startPolling = useCallback(() => {
    pollIntervalRef.current = setInterval(async () => {
      if (!sessionIdRef.current) return;
      const t0 = Date.now();
      try {
        const data = await proxyCall({ action: "poll", session_id: sessionIdRef.current });
        if (data.error) { stopPolling(); setStatus("error"); addMessage(`⚠ ${data.error}`, "error"); return; }
        if (data.lines?.length) {
          setPingMs(Date.now() - t0);
          processLines(data.lines);
        }
      } catch {
        stopPolling();
        setStatus("error");
        addMessage("⚠ Потеряно соединение с прокси", "error");
      }
    }, 2000);
  }, [addMessage, processLines, stopPolling]);

  const sendRaw = useCallback(async (line: string) => {
    if (!sessionIdRef.current) return;
    setBytesSent((b) => b + line.length + 2);
    addMessage(line, "out");
    try {
      const data = await proxyCall({ action: "send", session_id: sessionIdRef.current, commands: [line] });
      if (data.lines?.length) processLines(data.lines);
    } catch {
      addMessage("⚠ Ошибка отправки", "error");
    }
  }, [addMessage, processLines]);

  const connect = useCallback(async () => {
    if (sessionIdRef.current) await disconnect();
    if (!inputRecovery.trim()) { addMessage("⚠ Введите RECOVERY код", "error"); return; }

    setStatus("connecting");
    addMessage(`--- Подключение к ${settings.server}:${settings.port} ---`, "system");

    try {
      const data = await proxyCall({ action: "connect", host: settings.server, port: parseInt(settings.port) });
      if (data.error) {
        setStatus("error");
        addMessage(`⚠ ${data.error}`, "error");
        return;
      }
      sessionIdRef.current = data.session_id;
    } catch (e) {
      setStatus("error");
      addMessage(`⚠ Ошибка прокси: ${e}`, "error");
      return;
    }

    setStatus("online");
    const now = new Date();
    setConnectedAt(now);
    uptimeIntervalRef.current = setInterval(() => setUptime(Math.floor((Date.now() - now.getTime()) / 1000)), 1000);
    addMessage(`--- Соединение установлено ---`, "system");

    const cmds: string[] = [
      `IDENT ${settings.ident} -2 4030 1 2 :${settings.nick}`,
      `HAAAPSI ${inputRecovery.trim()} 20 24`,
      `RECOVER ${inputRecovery.trim()}`,
      `DOMAINS ${settings.server}`,
    ];
    if (inputUser.trim() && inputPass.trim()) {
      cmds.push(`REGISTER ${inputUser.trim()} ${inputPass.trim()} урарегнее`);
      cmds.push(`USER ${inputUser.trim()} ${inputPass.trim()} урарегнее 05030c0a07`);
    }
    cmds.push(`FWLISTVER 336`, `ADDONS 252244 1`, `MYADDONS 252244 1`, `PHONE 960 1846 0 2 :chrome 148.0.0.0`, `JOIN`);

    cmds.forEach((c) => { setBytesSent((b) => b + c.length + 2); addMessage(c, "out"); });

    try {
      const data = await proxyCall({ action: "send", session_id: sessionIdRef.current, commands: cmds });
      if (data.lines?.length) processLines(data.lines);
    } catch (e) {
      addMessage(`⚠ Ошибка handshake: ${e}`, "error");
    }

    startPolling();
  }, [inputRecovery, inputUser, inputPass, settings, disconnect, addMessage, processLines, startPolling]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => () => { stopPolling(); }, [stopPolling]);

  const statusLabel: Record<ConnStatus, string> = {
    offline: "Офлайн", connecting: "Подключение...", online: "Онлайн", error: "Ошибка",
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "login", label: "Вход", icon: "LogIn" },
    { id: "messages", label: "Сообщения", icon: "Terminal" },
    { id: "status", label: "Статус", icon: "Activity" },
    { id: "settings", label: "Настройки", icon: "Settings2" },
  ];

  return (
    <div className="min-h-screen flex flex-col" style={{ fontFamily: "'Golos Text', sans-serif" }}>
      {/* Header */}
      <header className="glass border-b border-border sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm text-black"
              style={{ background: "linear-gradient(135deg, #00ffd5, #bf5fff)" }}>G</div>
            <div>
              <div className="font-bold text-sm neon-text">GALA IRC</div>
              <div className="text-[10px] text-muted-foreground font-mono">galaxy.mobstudio.ru</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${
              status === "online" ? "status-dot-online" :
              status === "connecting" ? "status-dot-connecting" :
              status === "error" ? "status-dot-offline" : "bg-muted-foreground"
            }`} />
            <span className="text-xs text-muted-foreground font-mono">{statusLabel[status]}</span>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <nav className="glass border-b border-border">
        <div className="max-w-5xl mx-auto px-4">
          <div className="flex">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
                  tab === t.id ? "border-[#00ffd5] text-[#00ffd5]" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}>
                <Icon name={t.icon} size={15} />
                <span className="hidden sm:block">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">

        {/* ── LOGIN ── */}
        {tab === "login" && (
          <div className="animate-fade-in max-w-md mx-auto">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-black mb-2"
                style={{ background: "linear-gradient(90deg, #00ffd5, #bf5fff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Подключение
              </h1>
              <p className="text-muted-foreground text-sm">Введите данные для входа в IRC сеть</p>
            </div>

            <div className="rounded-2xl border neon-border p-6 glass space-y-4">
              {[
                { label: "Recovery код *", val: inputRecovery, set: setInputRecovery, ph: "aat40nue15...", hint: "Уникальный код восстановления персонажа", type: "text" },
                { label: "User ID", val: inputUser, set: setInputUser, ph: "92076985", hint: "", type: "text" },
                { label: "Password", val: inputPass, set: setInputPass, ph: "••••••••••••••••", hint: "", type: "password" },
              ].map((f) => (
                <div key={f.label}>
                  <label className="block text-xs text-muted-foreground mb-1 font-mono uppercase tracking-wider">{f.label}</label>
                  <input type={f.type} value={f.val} onChange={(e) => f.set(e.target.value)} placeholder={f.ph}
                    className="w-full bg-muted border border-border rounded-xl px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[#00ffd5] transition-colors" />
                  {f.hint && <p className="text-[10px] text-muted-foreground mt-1">{f.hint}</p>}
                </div>
              ))}
              <div className="pt-2">
                {status === "online" || status === "connecting" ? (
                  <button onClick={disconnect}
                    className="w-full py-3 rounded-xl font-bold text-sm transition-all border"
                    style={{ borderColor: "#ff2e2e", color: "#ff2e2e", background: "hsla(0,90%,60%,0.08)" }}>
                    Отключиться
                  </button>
                ) : (
                  <button onClick={() => { connect(); setTab("messages"); }}
                    className="w-full py-3 rounded-xl font-bold text-sm text-black hover:opacity-90 active:scale-95 transition-all"
                    style={{ background: "linear-gradient(135deg, #00ffd5, #00c4a3)" }}>
                    Подключиться
                  </button>
                )}
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-border p-4 glass font-mono text-xs space-y-1">
              <div className="text-[#bf5fff] font-bold mb-2">Handshake последовательность:</div>
              <div><span style={{ color: "#bf5fff" }}>HAAAPSI</span> [recovery] 20 24</div>
              <div><span style={{ color: "#bf5fff" }}>RECOVER</span> [recovery]</div>
              <div><span style={{ color: "#00ffd5" }}>REGISTER</span> [user] [pass]</div>
              <div><span style={{ color: "#39ff14" }}>999 :AUTH OK</span> — успех</div>
            </div>
          </div>
        )}

        {/* ── MESSAGES ── */}
        {tab === "messages" && (
          <div className="animate-fade-in flex flex-col" style={{ height: "calc(100vh - 200px)" }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Icon name="Terminal" size={16} className="text-[#00ffd5]" />
                <span className="text-sm font-semibold neon-text">IRC Консоль</span>
                <span className="text-xs text-muted-foreground font-mono">({messages.length})</span>
                {status === "online" && (
                  <span className="text-[10px] font-mono px-2 py-[2px] rounded-full" style={{ background: "hsla(174,100%,50%,0.1)", color: "#00ffd5" }}>
                    опрос каждые 2с
                  </span>
                )}
              </div>
              <button onClick={() => setMessages([])}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
                <Icon name="Trash2" size={13} /> Очистить
              </button>
            </div>

            <div className="flex-1 glass rounded-2xl border border-border overflow-y-auto p-4 font-mono text-xs space-y-[2px]">
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-muted-foreground text-center">
                  <div>
                    <div className="text-2xl mb-2">📡</div>
                    <div>Нет сообщений</div>
                    <div className="text-[10px] mt-1">Подключитесь через вкладку «Вход»</div>
                  </div>
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className="flex gap-2 leading-relaxed hover:bg-white/5 rounded px-1 py-[1px] transition-colors">
                    <span className="text-muted-foreground shrink-0 select-none opacity-60">{msg.time}</span>
                    <span className="shrink-0 select-none w-3">
                      {msg.type === "out" && <span style={{ color: "#555" }}>›</span>}
                      {msg.type === "in" && <span style={{ color: "#333" }}>‹</span>}
                      {msg.type === "system" && <span style={{ color: "#bf5fff" }}>★</span>}
                      {msg.type === "error" && <span style={{ color: "#ff2e2e" }}>!</span>}
                    </span>
                    <span className="break-all">
                      {msg.type === "in" && msg.parsed ? (
                        <>
                          <span style={{ color: getCommandColor(msg.parsed.command), fontWeight: 700 }}>{msg.parsed.command}</span>
                          {" "}<span style={{ color: "#aaa" }}>{msg.parsed.params}</span>
                        </>
                      ) : (
                        <span style={{
                          color: msg.type === "system" ? "#bf5fff" : msg.type === "error" ? "#ff2e2e" : msg.type === "out" ? "#666" : "#aaa"
                        }}>{msg.raw}</span>
                      )}
                    </span>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="mt-3 flex gap-2">
              <input type="text" value={sendInput} onChange={(e) => setSendInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && sendInput.trim()) { sendRaw(sendInput.trim()); setSendInput(""); } }}
                placeholder="IRC команда... (Enter для отправки)"
                disabled={status !== "online"}
                className="flex-1 bg-muted border border-border rounded-xl px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[#00ffd5] transition-colors disabled:opacity-40" />
              <button
                onClick={() => { if (sendInput.trim()) { sendRaw(sendInput.trim()); setSendInput(""); } }}
                disabled={status !== "online" || !sendInput.trim()}
                className="px-4 py-3 rounded-xl font-bold text-sm text-black transition-all disabled:opacity-40 hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #00ffd5, #00c4a3)" }}>
                <Icon name="Send" size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── STATUS ── */}
        {tab === "status" && (
          <div className="animate-fade-in">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-black mb-1"
                style={{ background: "linear-gradient(90deg, #00ffd5, #bf5fff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Статус подключения
              </h2>
            </div>

            <div className="flex justify-center mb-8">
              <div className="w-32 h-32 rounded-full flex flex-col items-center justify-center"
                style={{
                  border: `2px solid ${status === "online" ? "#39ff14" : status === "connecting" ? "#ff8c00" : status === "error" ? "#ff2e2e" : "#333"}`,
                  background: status === "online" ? "radial-gradient(circle, hsla(120,100%,40%,0.15), transparent)" :
                    status === "connecting" ? "radial-gradient(circle, hsla(30,100%,50%,0.15), transparent)" :
                    status === "error" ? "radial-gradient(circle, hsla(0,90%,60%,0.15), transparent)" : "transparent",
                  boxShadow: status === "online" ? "0 0 30px hsla(120,100%,40%,0.3)" : "none",
                }}>
                <Icon name={status === "online" ? "Wifi" : status === "connecting" ? "Loader2" : "WifiOff"} size={36}
                  style={{ color: status === "online" ? "#39ff14" : status === "connecting" ? "#ff8c00" : status === "error" ? "#ff2e2e" : "#555" }}
                  className={status === "connecting" ? "animate-spin" : ""} />
                <div className="text-xs mt-2 font-mono" style={{ color: status === "online" ? "#39ff14" : "#666" }}>
                  {statusLabel[status]}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {[
                { label: "Сервер", value: settings.server, icon: "Server" },
                { label: "Порт", value: settings.port, icon: "Network" },
                { label: "Задержка", value: pingMs !== null ? `${pingMs} мс` : "—", icon: "Timer" },
                { label: "Аптайм", value: connectedAt ? `${uptime}с` : "—", icon: "Clock" },
              ].map((stat) => (
                <div key={stat.label} className="glass border border-border rounded-2xl p-4 text-center">
                  <Icon name={stat.icon} size={20} className="mx-auto mb-2" style={{ color: "#00ffd5" }} />
                  <div className="font-mono text-base font-bold text-foreground">{stat.value}</div>
                  <div className="text-xs text-muted-foreground">{stat.label}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="glass border border-border rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Icon name="ArrowUp" size={14} style={{ color: "#00ffd5" }} />
                  <span className="text-xs text-muted-foreground font-mono uppercase">Отправлено</span>
                </div>
                <div className="font-mono text-2xl font-bold" style={{ color: "#00ffd5" }}>{bytesSent}</div>
                <div className="text-xs text-muted-foreground">байт</div>
              </div>
              <div className="glass border border-border rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Icon name="ArrowDown" size={14} style={{ color: "#bf5fff" }} />
                  <span className="text-xs text-muted-foreground font-mono uppercase">Получено</span>
                </div>
                <div className="font-mono text-2xl font-bold" style={{ color: "#bf5fff" }}>{bytesRecv}</div>
                <div className="text-xs text-muted-foreground">байт</div>
              </div>
            </div>

            {status === "online" ? (
              <button onClick={disconnect}
                className="w-full py-3 rounded-xl font-bold text-sm border transition-all"
                style={{ borderColor: "#ff2e2e", color: "#ff2e2e", background: "hsla(0,90%,60%,0.08)" }}>
                Отключиться
              </button>
            ) : (
              <button onClick={() => setTab("login")}
                className="w-full py-3 rounded-xl font-bold text-sm text-black transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #00ffd5, #00c4a3)" }}>
                Перейти ко входу
              </button>
            )}
          </div>
        )}

        {/* ── SETTINGS ── */}
        {tab === "settings" && (
          <div className="animate-fade-in max-w-lg mx-auto">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-black mb-1"
                style={{ background: "linear-gradient(90deg, #00ffd5, #bf5fff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Настройки
              </h2>
              <p className="text-muted-foreground text-sm">Параметры подключения к IRC серверу</p>
            </div>

            <div className="glass border neon-border rounded-2xl p-6 space-y-4 mb-4">
              {([
                { key: "server", label: "Сервер", placeholder: "galaxy.mobstudio.ru" },
                { key: "port", label: "Порт TCP", placeholder: "6667" },
                { key: "nick", label: "Ник", placeholder: "GALA" },
                { key: "ident", label: "Ident", placeholder: "352" },
              ] as const).map((field) => (
                <div key={field.key}>
                  <label className="block text-xs text-muted-foreground mb-1 font-mono uppercase tracking-wider">{field.label}</label>
                  <input type="text" value={settings[field.key]}
                    onChange={(e) => setSettings((s) => ({ ...s, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="w-full bg-muted border border-border rounded-xl px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[#00ffd5] transition-colors" />
                </div>
              ))}
              <div className="rounded-xl p-3 text-xs font-mono" style={{ background: "hsla(174,100%,50%,0.05)", border: "1px solid hsla(174,100%,50%,0.2)" }}>
                <span style={{ color: "#00ffd5" }}>ℹ</span> Подключение идёт через TCP-прокси — прямой WebSocket не нужен
              </div>
              <button onClick={() => addMessage("--- Настройки сохранены ---", "system")}
                className="w-full py-3 rounded-xl font-bold text-sm text-black hover:opacity-90 transition-all"
                style={{ background: "linear-gradient(135deg, #00ffd5, #00c4a3)" }}>
                Сохранить
              </button>
            </div>

            <div className="rounded-xl border border-border p-4 glass font-mono text-xs space-y-1">
              <div className="text-[#bf5fff] font-bold mb-2">Порядок IRC handshake:</div>
              <div><span style={{ color: "#00ffd5" }}>IDENT</span> → HAAAPSI → RECOVER → DOMAINS</div>
              <div><span style={{ color: "#00ffd5" }}>REGISTER</span> → USER → FWLISTVER → ADDONS</div>
              <div><span style={{ color: "#39ff14" }}>999 :AUTH OK</span> — успешная авторизация</div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}