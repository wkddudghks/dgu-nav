// 서버 없이 열리는 한 파일짜리 길찾기 페이지 만들기: node build_standalone.js → navigation.html
const fs = require('fs');
const map = fs.readFileSync(__dirname + '/public/map.json', 'utf8');
const html = fs.readFileSync(__dirname + '/standalone.template.html', 'utf8').replace('/*MAP*/null', JSON.stringify(JSON.parse(map)));
fs.writeFileSync(__dirname + '/navigation.html', html);
console.log('navigation.html 생성', html.length, 'bytes');
