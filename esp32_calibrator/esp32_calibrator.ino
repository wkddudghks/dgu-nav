/*
 * 스테이션 간격 설정기 (ESP32 + I2C LCD + 푸시버튼 4개)
 *
 * 하는 일
 *  - 버튼 1~4 = 스테이션 1~4
 *      짧게 누르기  → 그 스테이션을 기준점에서 1m 더 멀리 (+1m)
 *      길게 누르기(0.8초 이상) → 1m 가깝게 (-1m)
 *  - 바뀐 값을 바로 서버로 보내고, LCD에 표시
 *  - 가만히 두면 LCD가 "스테이션 위치" ↔ "폰 추정 위치"를 번갈아 보여줌
 *  - 이 보드는 BLE 스캔을 하지 않는 "리모컨" 역할 (스테이션 ESP32와 별개)
 *
 * 배선 (확장보드면 각 번호 줄의 S / G 에 꽂기)
 *  I2C LCD : VCC → V(5V)  GND → G   SDA → 21번 S   SCL → 22번 S
 *  버튼1   : 32번 S ↔ 32번 G
 *  버튼2   : 33번 S ↔ 33번 G
 *  버튼3   : 25번 S ↔ 25번 G
 *  버튼4   : 26번 S ↔ 26번 G
 *  (내부 풀업 사용 → 저항 필요 없음. 34~39번 핀은 풀업이 없어서 버튼용으로 쓰면 안 됨)
 *
 * 라이브러리: "LiquidCrystal I2C" (Frank de Brabander)
 */
#include <WiFi.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ======== 바꿀 부분 ========
const char* WIFI_SSID  = "hotspot-name";
const char* WIFI_PASS  = "hotspot-pass";
// 서버 주소는 자동으로 찾아요. 안 될 때 쓸 노트북 주소 (ipconfig의 IPv4), 자동만 쓰려면 ""
const char* SERVER_IP  = "172.30.1.93";
// ===========================

const uint16_t DISCOVERY_PORT = 4210;
WiFiUDP udp;
String serverBase = "";
bool udpStarted = false;

const int BTN[4] = {32, 33, 25, 26};
const unsigned long LONG_PRESS_MS = 800;
const unsigned long DEBOUNCE_MS = 40;

LiquidCrystal_I2C lcd(0x27, 16, 2);

int pos[4] = {0, 5, 10, 15};      // 기준점에서 각 스테이션까지 거리(m) — 서버 값으로 덮어씀
float phoneEst = -1;              // 서버가 추정한 폰 위치(m), 없으면 -1
String nearest = "";
bool serverOk = false;

// 버튼 상태
bool lastRaw[4], stable[4];
unsigned long changedAt[4], pressedAt[4];

// 화면
unsigned long lastActionMs = 0, lastPollMs = 0, lastPageMs = 0;
int page = 0;
int lastChanged = -1;

void lcdLine(int row, String t) {
  if (t.length() > 16) t = t.substring(0, 16);
  while (t.length() < 16) t += ' ';
  lcd.setCursor(0, row); lcd.print(t);
}

String pad(int v, int w) { String s = String(v); while ((int)s.length() < w) s = " " + s; return s; }

// 간단한 JSON 숫자 꺼내기: "STATION_01":5 → 5
float jsonNum(const String& s, const String& key, float def) {
  int i = s.indexOf("\"" + key + "\":");
  if (i < 0) return def;
  i += key.length() + 3;
  if (s.startsWith("null", i)) return def;
  return s.substring(i).toFloat();
}

void applyResponse(const String& res) {
  for (int k = 0; k < 4; k++) pos[k] = (int)jsonNum(res, "STATION_0" + String(k + 1), pos[k]);
  phoneEst = jsonNum(res, "estimate", -1);
  int n = res.indexOf("\"nearest\":\"");
  nearest = n >= 0 ? res.substring(n + 11, res.indexOf('"', n + 11)) : "";
}

void checkDiscovery() {
  if (WiFi.status() != WL_CONNECTED) { udpStarted = false; return; }
  if (!udpStarted) { udp.stop(); udp.begin(DISCOVERY_PORT); udpStarted = true; }
  while (udp.parsePacket() > 0) {
    char buf[32];
    int len = udp.read(buf, sizeof(buf) - 1);
    if (len <= 0) continue;
    buf[len] = 0;
    if (strncmp(buf, "DGU-NAV ", 8) != 0) continue;
    String base = "http://" + udp.remoteIP().toString() + ":" + String(atoi(buf + 8));
    if (base != serverBase) { serverBase = base; Serial.println("서버 찾음: " + serverBase); }
  }
}

void fetchState() {
  if (WiFi.status() != WL_CONNECTED || serverBase == "") { serverOk = false; return; }
  HTTPClient http;
  http.begin(serverBase + "/corridor");
  http.setTimeout(1200);
  int code = http.GET();
  serverOk = code == 200;
  if (serverOk) applyResponse(http.getString());
  http.end();
}

void pushPositions() {
  if (WiFi.status() != WL_CONNECTED || serverBase == "") { serverOk = false; return; }
  HTTPClient http;
  http.begin(serverBase + "/corridor");
  http.setTimeout(1200);
  http.addHeader("Content-Type", "application/json");
  String body = "{\"positions\":{";
  for (int k = 0; k < 4; k++) body += "\"STATION_0" + String(k + 1) + "\":" + pos[k] + (k < 3 ? "," : "");
  body += "}}";
  int code = http.POST(body);
  serverOk = code == 200;
  if (serverOk) applyResponse(http.getString());
  Serial.printf("[설정] %s -> HTTP %d\n", body.c_str(), code);
  http.end();
}

void showPositions() {
  // 예) "1: 0m   2: 5m"
  //     "3:10m   4:15m"
  lcdLine(0, "1:" + pad(pos[0], 2) + "m   2:" + pad(pos[1], 2) + "m");
  lcdLine(1, "3:" + pad(pos[2], 2) + "m   4:" + pad(pos[3], 2) + "m");
}

void showPhone() {
  if (WiFi.status() != WL_CONNECTED) { lcdLine(0, "WiFi offline"); lcdLine(1, WIFI_SSID); return; }
  if (serverBase == "")     { lcdLine(0, "Finding server.."); lcdLine(1, "Run server.js"); return; }
  if (!serverOk)            { lcdLine(0, "Server offline"); lcdLine(1, serverBase.substring(7)); return; }
  if (phoneEst < 0)         { lcdLine(0, "Phone: no signal"); lcdLine(1, "Check beacon app"); return; }
  lcdLine(0, "Phone ~" + String(phoneEst, 1) + "m");
  lcdLine(1, nearest.length() ? "Near: S" + nearest.substring(9) : "Near: -");
}

void showChange(int k) {
  lcdLine(0, "Station " + String(k + 1) + " -> " + String(pos[k]) + "m");
  int gap = k > 0 ? pos[k] - pos[k - 1] : pos[k];
  lcdLine(1, k > 0 ? "Gap " + String(k) + "-" + String(k + 1) + ": " + String(gap) + "m"
                   : "From start: " + String(gap) + "m");
}

void onPress(int k, bool longPress) {
  pos[k] += longPress ? -1 : 1;
  if (pos[k] < 0) pos[k] = 0;
  if (pos[k] > 99) pos[k] = 99;
  lastChanged = k;
  lastActionMs = millis();
  showChange(k);          // 먼저 화면에 보여주고
  pushPositions();        // 서버로 전송
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  lcd.init(); lcd.backlight();
  lcdLine(0, "Station spacing");
  lcdLine(1, "WiFi connecting");

  for (int k = 0; k < 4; k++) {
    pinMode(BTN[k], INPUT_PULLUP);
    lastRaw[k] = stable[k] = HIGH;
    changedAt[k] = pressedAt[k] = 0;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  lcdLine(1, "Finding server..");
  for (int i = 0; i < 50 && serverBase == ""; i++) { checkDiscovery(); delay(100); }  // 최대 5초 기다림
  if (serverBase == "" && strlen(SERVER_IP) > 0) serverBase = String("http://") + SERVER_IP + ":3001";
  fetchState();           // 서버에 저장된 간격으로 시작
  showPositions();
}

void loop() {
  unsigned long now = millis();

  // 버튼 4개 읽기 (디바운스 + 짧게/길게 구분, 손을 뗄 때 판정)
  for (int k = 0; k < 4; k++) {
    bool raw = digitalRead(BTN[k]);
    if (raw != lastRaw[k]) { lastRaw[k] = raw; changedAt[k] = now; }
    if (now - changedAt[k] > DEBOUNCE_MS && raw != stable[k]) {
      stable[k] = raw;
      if (raw == LOW) pressedAt[k] = now;                       // 눌림
      else onPress(k, now - pressedAt[k] >= LONG_PRESS_MS);     // 뗌
    }
  }

  // 와이파이 끊기면 재연결
  if (WiFi.status() != WL_CONNECTED && now - lastPollMs > 5000) { WiFi.reconnect(); lastPollMs = now; }

  checkDiscovery();

  // 1초마다 서버에서 폰 추정 위치 받아오기
  if (now - lastPollMs > 1000) { lastPollMs = now; fetchState(); }

  // 버튼 조작 후 2초는 바뀐 값 유지, 그 뒤엔 2.5초마다 화면 번갈아 보기
  if (now - lastActionMs > 2000 && now - lastPageMs > 2500) {
    lastPageMs = now;
    page = 1 - page;
    if (page == 0) showPositions(); else showPhone();
  }
}
