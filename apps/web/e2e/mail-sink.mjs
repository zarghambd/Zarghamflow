import { Buffer } from 'node:buffer';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { URL } from 'node:url';

const messages = [];
const addressPattern = /Your(?:=20| )ZarghamFlow(?:=20| )code(?:=20| )is(?:=20| )(\d{6})/i;

function findCode(message) {
  const quotedPrintable = message.replace(/=\r?\n/g, '').replace(/=([A-F\d]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  const direct = addressPattern.exec(quotedPrintable)?.[1];
  if (direct) return direct;
  for (const match of message.matchAll(/Content-Transfer-Encoding:\s*base64\r?\n\r?\n([A-Za-z\d+/=\r\n]+)/gi)) {
    const decoded = Buffer.from(match[1].replace(/\s/g, ''), 'base64').toString('utf8');
    const code = addressPattern.exec(decoded)?.[1];
    if (code) return code;
  }
  return undefined;
}

const smtp = createTcpServer((socket) => {
  let input = '';
  let message = '';
  let recipient = '';
  let readingData = false;
  socket.write('220 localhost ESMTP\r\n');

  socket.on('data', (chunk) => {
    input += chunk.toString('utf8');
    let newline = input.indexOf('\r\n');
    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 2);
      if (readingData) {
        if (line === '.') {
          readingData = false;
          messages.push({ recipient, message });
          message = '';
          socket.write('250 Message accepted\r\n');
        } else {
          message += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
        }
      } else if (/^(EHLO|HELO)\b/i.test(line)) {
        socket.write('250-localhost\r\n250-PIPELINING\r\n250 8BITMIME\r\n');
      } else if (/^RCPT TO:/i.test(line)) {
        recipient = /^RCPT TO:\s*<?([^>\s]+)>?/i.exec(line)?.[1]?.toLowerCase() ?? '';
        socket.write('250 Recipient accepted\r\n');
      } else if (/^DATA$/i.test(line)) {
        readingData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (/^QUIT$/i.test(line)) {
        socket.write('221 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 OK\r\n');
      }
      newline = input.indexOf('\r\n');
    }
  });
});

const http = createHttpServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:3002');
  if (url.pathname === '/health') {
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === '/latest-code') {
    const requestedEmail = (url.searchParams.get('email') ?? '').toLowerCase();
    const code = [...messages].reverse()
      .filter((entry) => !requestedEmail || entry.recipient === requestedEmail)
      .map((entry) => findCode(entry.message))
      .find(Boolean);
    if (!code) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code }));
    return;
  }
  response.writeHead(404).end();
});

smtp.listen(1026, '127.0.0.1');
http.listen(3002, '127.0.0.1');
