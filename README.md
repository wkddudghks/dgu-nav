# 신공학관 실내 내비게이션 (ESP32 + BLE)

## 실행
1. `npm install`
2. (층을 바꾸려면) `node gen_map.js 5 6` ← 원하는 층 번호를 나열하면 public/map.json이 다시 만들어짐
3. `node server.js` → 브라우저 `http://localhost:3001` (폰은 `http://<노트북IP>:3001`)
4. ESP32 없이 보려면 화면 위 "데모 모드"를 켜고 복도의 점을 클릭

## ESP32 설치
`esp32_station.ino`의 `STATION_ID`를 보드마다 바꿔 업로드하세요. 위치는 `node gen_map.js` 실행 시 출력됩니다.

| ID | 위치 |
|---|---|
| STATION_01 / 05 | 5층 / 6층 서쪽 복도 (x107~x109 앞) |
| STATION_02 / 06 | 중앙 엘리베이터 앞 |
| STATION_03 / 07 | 북동 엘리베이터 앞 |
| STATION_04 / 08 | 2구역 입구 (x240 앞) |

## 지도 수정
`gen_map.js`의 `P`(복도 지점), `CORRIDORS`(복도 연결), `ROOMS`(방 위치)를 고치고 다시 실행하세요.
실 이름은 `DESCRIPTIONS`에 층별로 추가합니다.

## 다른 사람도 보게 하기 (인터넷 공유)
1. 처음 한 번만: 명령창에서 `winget install --id Cloudflare.cloudflared`
2. `share.bat` 더블클릭 → 화면에 나오는 `https://xxxx.trycloudflare.com` 주소를 공유
- ESP32는 지금처럼 핫스팟 IP(192.168.137.1)로 보내면 됩니다. 바꿀 것 없음.
- 인터넷으로 들어온 /rssi 요청은 서버가 막습니다(가짜 위치 방지).
- 주소는 share.bat을 실행할 때마다 바뀝니다. 노트북을 끄면 접속이 끊깁니다.

## 우노 설정기 (ESP32 설정기 대신)
1. `uno_calibrator/uno_calibrator.ino`를 우노에 업로드 (LCD SDA→A4, SCL→A5 / 버튼 D2~D5 ↔ GND)
2. 창 1: `node server.js`
3. 창 2: `node uno_bridge.js` (포트를 못 찾으면 `node uno_bridge.js COM5`)
- Arduino IDE 시리얼 모니터는 닫아야 해요 (포트를 같이 못 씀)

## 네모 방 모드 (room.html)
- `http://localhost:3001/room.html`
- 방 가로·세로(m)를 입력하고, S1~S4를 끌어서 실제 놓은 자리에 맞추기 (10cm 단위, room.json에 저장)
- 빈 곳을 누르면 실제 위치, "오차 기록"으로 추정과 비교 (cm 단위)
