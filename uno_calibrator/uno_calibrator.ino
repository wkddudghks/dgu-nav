/*
 * 스테이션 간격 설정기 — 아두이노 우노 버전 (USB로 노트북에 연결)
 *
 * 하는 일 (ESP32 설정기와 같음)
 *  - 버튼 1~4 = 스테이션 1~4
 *      짧게 누르기 → 기준점에서 1m 멀리 (+1m)
 *      길게 누르기(0.8초 이상) → 1m 가깝게 (-1m)
 *  - LCD에 간격과 폰 추정 위치 표시
 *  - 우노엔 와이파이가 없으므로 USB 시리얼로 노트북의 uno_bridge.js와 대화
 *
 * 배선
 *  I2C LCD : VCC → 5V   GND → GND   SDA → A4   SCL → A5
 *  버튼1   : D2 ↔ GND
 *  버튼2   : D3 ↔ GND
 *  버튼3   : D4 ↔ GND
 *  버튼4   : D5 ↔ GND      (내부 풀업 사용 → 저항 필요 없음)
 *
 * 라이브러리: "LiquidCrystal I2C" (Frank de Brabander)
 * 보드: Arduino Uno
 *
 * 노트북과 주고받는 메시지 (한 줄씩, 9600bps)
 *  우노 → 노트북 :  GET                 (처음 켜질 때 저장된 간격 요청)
 *                   SET 0 5 10 15       (버튼 눌러 바뀐 간격)
 *  노트북 → 우노 :  POS 0 5 10 15       (서버에 저장된 간격)
 *                   EST 7.3 2           (폰 추정 위치 m, 가장 가까운 스테이션 번호 / 없으면 EST - 0)
 */
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);   // 화면이 안 나오면 0x3F로 바꿔보기

const int BTN[4] = {2, 3, 4, 5};
const unsigned long LONG_PRESS_MS = 800;
const unsigned long DEBOUNCE_MS = 40;

int pos[4] = {0, 5, 10, 15};
float phoneEst = -1;
int nearestNo = 0;
unsigned long lastMsgMs = 0;          // 노트북에서 마지막으로 메시지 받은 시각

bool lastRaw[4], stable[4];
unsigned long changedAt[4], pressedAt[4];

unsigned long lastActionMs = 0, lastPageMs = 0, lastGetMs = 0;
int page = 0;
char line[40];
int lineLen = 0;

void lcdLine(int row, String t) {
  if (t.length() > 16) t = t.substring(0, 16);
  while (t.length() < 16) t += ' ';
  lcd.setCursor(0, row);
  lcd.print(t);
}

String pad(int v) { return v < 10 ? " " + String(v) : String(v); }

void showPositions() {
  lcdLine(0, "1:" + pad(pos[0]) + "m   2:" + pad(pos[1]) + "m");
  lcdLine(1, "3:" + pad(pos[2]) + "m   4:" + pad(pos[3]) + "m");
}

void showPhone() {
  if (lastMsgMs == 0 || millis() - lastMsgMs > 5000) {
    lcdLine(0, "PC not linked");
    lcdLine(1, "Run uno_bridge");
    return;
  }
  if (phoneEst < 0) { lcdLine(0, "Phone: no signal"); lcdLine(1, "Check beacon app"); return; }
  lcdLine(0, "Phone ~" + String(phoneEst, 1) + "m");
  lcdLine(1, nearestNo ? "Near: S" + String(nearestNo) : "Near: -");
}

void showChange(int k) {
  lcdLine(0, "Station " + String(k + 1) + " -> " + String(pos[k]) + "m");
  if (k == 0) lcdLine(1, "From start: " + String(pos[0]) + "m");
  else        lcdLine(1, "Gap " + String(k) + "-" + String(k + 1) + ": " + String(pos[k] - pos[k - 1]) + "m");
}

void sendSet() {
  Serial.print("SET");
  for (int k = 0; k < 4; k++) { Serial.print(' '); Serial.print(pos[k]); }
  Serial.println();
}

void onPress(int k, bool longPress) {
  pos[k] += longPress ? -1 : 1;
  if (pos[k] < 0) pos[k] = 0;
  if (pos[k] > 99) pos[k] = 99;
  lastActionMs = millis();
  showChange(k);
  sendSet();
}

// 노트북에서 온 한 줄 처리
void handleLine(char* s) {
  if (strncmp(s, "POS ", 4) == 0) {
    int a, b, c, d;
    if (sscanf(s + 4, "%d %d %d %d", &a, &b, &c, &d) == 4) { pos[0] = a; pos[1] = b; pos[2] = c; pos[3] = d; }
    lastMsgMs = millis();
  } else if (strncmp(s, "EST ", 4) == 0) {
    char* p = s + 4;
    if (*p == '-') { phoneEst = -1; p++; }
    else { phoneEst = atof(p); while (*p && *p != ' ') p++; }   // 우노 sscanf는 %f를 못 읽어서 atof 사용
    nearestNo = atoi(p);
    lastMsgMs = millis();
  }
}

void readSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') { line[lineLen] = 0; if (lineLen) handleLine(line); lineLen = 0; }
    else if (lineLen < (int)sizeof(line) - 1) line[lineLen++] = ch;
  }
}

void setup() {
  Serial.begin(9600);
  lcd.init();
  lcd.backlight();
  lcdLine(0, "Station spacing");
  lcdLine(1, "Uno calibrator");
  for (int k = 0; k < 4; k++) {
    pinMode(BTN[k], INPUT_PULLUP);
    lastRaw[k] = stable[k] = HIGH;
    changedAt[k] = pressedAt[k] = 0;
  }
  delay(1500);
  Serial.println("GET");
  lastGetMs = millis();
  showPositions();
}

void loop() {
  unsigned long now = millis();
  readSerial();

  for (int k = 0; k < 4; k++) {
    bool raw = digitalRead(BTN[k]);
    if (raw != lastRaw[k]) { lastRaw[k] = raw; changedAt[k] = now; }
    if (now - changedAt[k] > DEBOUNCE_MS && raw != stable[k]) {
      stable[k] = raw;
      if (raw == LOW) pressedAt[k] = now;
      else onPress(k, now - pressedAt[k] >= LONG_PRESS_MS);
    }
  }

  // 노트북 연결이 안 됐으면 3초마다 다시 요청
  if ((lastMsgMs == 0 || now - lastMsgMs > 5000) && now - lastGetMs > 3000) {
    Serial.println("GET");
    lastGetMs = now;
  }

  if (now - lastActionMs > 2000 && now - lastPageMs > 2500) {
    lastPageMs = now;
    page = 1 - page;
    if (page == 0) showPositions(); else showPhone();
  }
}
