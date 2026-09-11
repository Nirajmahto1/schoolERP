const http = require('http');
const data = JSON.stringify({ email: 'principal@demo-main.demo.edu.in', password: 'Admin@123' });
const req = http.request({ host: 'localhost', port: 4000, path: '/api/v1/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
  let body = ''; res.on('data', c => body += c);
  res.on('end', () => { console.log('STATUS', res.statusCode, body.slice(0, 200)); process.exit(0); });
});
req.end(data);
setTimeout(() => { console.log('TIMEOUT (with content-length set)'); process.exit(2); }, 8000);
