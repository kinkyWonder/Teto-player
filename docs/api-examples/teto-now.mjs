// Teto Player: WebSocket-клиент (Node 22+ — встроенный WebSocket; Node 18–21: npm i ws и import WebSocket from 'ws').
// node teto-now.mjs [токен]   — с токеном Enter = пауза/воспроизведение
const TOKEN = process.argv[2] ?? '';
function connect() {
  const ws = new WebSocket('ws://127.0.0.1:7710/v1/ws?pos=0');
  ws.onmessage = (m) => {
    const { event, data } = JSON.parse(m.data);
    if (event === 'hello' || event === 'track') console.log(data.track ? `\n▶ ${data.track.artist} — ${data.track.title}` : '\n■ остановлено');
    else if (event === 'line' && data.line) console.log('  ♪', data.line.text);
    else if (event === 'reply' && !data.ok) console.log('  ошибка:', data.error);
  };
  ws.onclose = () => setTimeout(connect, 3000);
  ws.onerror = () => {};
  process.stdin.removeAllListeners('data');
  process.stdin.on('data', () => TOKEN && ws.send(JSON.stringify({ cmd: 'toggle', token: TOKEN, id: Date.now() })));
}
connect();
