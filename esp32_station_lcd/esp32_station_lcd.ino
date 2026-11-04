/*
 * 실내 내비게이션 스테이션 + I2C LCD(16x2) + 푸시버튼
 *
 * 하는 일
 *  - 폰 iBeacon(Major/Minor)을 BLE로 스캔 → RSSI를 서버로 전송 (기존과 동일)
 *  - LCD에 신호 세기, "HERE!"(사용자가 이 스테이션 근처일 때), 서버 상태 표시
 *  - 버튼을 누를 때마다 LCD 화면 전환 (3페이지)
 *
 * 배선 (브레드보드)
 *  I2C LCD   VCC → VIN(5V)   GND → GND   SDA → GPIO21   SCL → GPIO22
 *  푸시버튼  한쪽 다리 → GPIO4,  대각선 반대쪽 다리 → GND   (내부 풀업 사용, 저항 필요 없음)
 *
 * Arduino IDE 준비
 *  - 라이브러리 매니저에서 "LiquidCrystal I2C" (Frank de Brabander) 설치
 *  - 보드: ESP32 Dev Module / Partition Scheme: Huge APP
 *  - LCD에 아무것도 안 보이면: ① LCD 뒷면 파란 나사(가변저항)를 돌려 명암 조절
 *                              ② 주소를 0x27 → 0x3F로 바꿔보기
 *  - 16x2 LCD는 한글이 안 나와요 → 영어/숫자만 사용
 */
#include <WiFi.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ======== 보드마다 바꿀 부분 ========
const char* STATION_ID   = "STATION_06";      // map.json의 stations와 같게
const char* STATION_NAME = "6F Center EV";     // LCD 첫 줄 (영어 16자 이내)
const char* WIFI_SSID    = "hotspot-name";
const char* WIFI_PASS    = "hotspot-pass";
const uint16_t TARGET_MAJOR = 123;
const uint16_t TARGET_MINOR = 123;
// ===================================

// 서버 주소는 자동으로 찾아요 (노트북 서버가 방송하는 "DGU-NAV 3001"을 들음)
const uint16_t DISCOVERY_PORT = 4210;
WiFiUDP udp;
String serverBase = "";

const int BUTTON_PIN = 4;
const int PAGES = 3;
LiquidCrystal_I2C lcd(0x27, 16, 2);

// BLE 콜백에서 쓰는 값
volatile int  scanRssi = 0;
volatile bool scanFound = false;

// 화면에 보여줄 상태
int  lastRssi = 0;
unsigned long lastSeenMs = 0;
bool isHere = false;          // 서버가 "이 스테이션이 가장 가깝다"고 판단했는지
String nearest = "-";         // 서버가 판단한 가장 가까운 스테이션
int  nearestFloor = 0;
int  httpCode = 0;
int  page = 0;

// 버튼: 인터럽트로 받아서 BLE 스캔 중에 눌러도 놓치지 않음
volatile bool btnPressed = false;
volatile unsigned long lastBtnMs = 0;
void IRAM_ATTR onButton() {
  unsigned long now = millis();
  if (now - lastBtnMs > 250) { btnPressed = true; lastBtnMs = now; }  // 디바운스
}

BLEScan* pBLEScan;
class BeaconCallback : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice dev) {
    if (!dev.haveManufacturerData()) return;
    auto md = dev.getManufacturerData();
    if (md.length() < 25) return;
    if ((uint8_t)md[0] != 0x4C || (uint8_t)md[1] != 0x00 ||
        (uint8_t)md[2] != 0x02 || (uint8_t)md[3] != 0x15) return;
    uint16_t major = ((uint8_t)md[20] << 8) | (uint8_t)md[21];
    uint16_t minor = ((uint8_t)md[22] << 8) | (uint8_t)md[23];
    if (major != TARGET_MAJOR || minor != TARGET_MINOR) return;
    scanRssi = dev.getRSSI();
    scanFound = true;
  }
};

// 16칸에 맞춰 남는 부분을 공백으로 지우며 출력
void lcdLine(int row, String text) {
  if (text.length() > 16) text = text.substring(0, 16);
  while (text.length() < 16) text += ' ';
  lcd.setCursor(0, row);
  lcd.print(text);
}

void drawLCD() {
  bool beaconRecent = lastSeenMs && millis() - lastSeenMs < 4000;
  switch (page) {
    case 0:  // 기본 화면: 스테이션 이름 + 신호
      lcdLine(0, STATION_NAME);
      if (!beaconRecent)  lcdLine(1, "No beacon");
      else if (isHere)    lcdLine(1, String(lastRssi) + "dBm  HERE!");
      else                lcdLine(1, String(lastRssi) + "dBm");
      break;
    case 1:  // 서버가 판단한 현재 위치
      lcdLine(0, "Nearest:" + (nearest == "-" ? String("-") : nearest.substring(8) + " " + String(nearestFloor) + "F"));
      lcdLine(1, "Me: " + String(STATION_ID).substring(8) + (beaconRecent ? " " + String(lastRssi) + "dBm" : " --"));
      break;
    case 2:  // 연결 상태
      lcdLine(0, WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "WiFi: offline");
      lcdLine(1, serverBase == "" ? "Finding server.." : httpCode == 200 ? "Server OK" : httpCode == 0 ? "Server: --" : "Server ERR " + String(httpCode));
      break;
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  lcdLine(0, "WiFi connecting");
  lcdLine(1, WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  Serial.println(WiFi.status() == WL_CONNECTED ? "WiFi OK " + WiFi.localIP().toString() : "WiFi FAIL");
  if (WiFi.status() == WL_CONNECTED) { udp.stop(); udp.begin(DISCOVERY_PORT); }
}

void checkDiscovery() {
  while (udp.parsePacket() > 0) {
    char buf[32];
    int len = udp.read(buf, sizeof(buf) - 1);
    if (len <= 0) continue;
    buf[len] = 0;
    if (strncmp(buf, "DGU-NAV ", 8) != 0) continue;
    String base = "http://" + udp.remoteIP().toString() + ":" + String(atoi(buf + 8));
    if (base != serverBase) { serverBase = base; Serial.println("Server found: " + serverBase); }
  }
}

void sendRssi(int rssi) {
  HTTPClient http;
  http.begin(serverBase + "/rssi");
  http.setTimeout(1500);
  http.addHeader("Content-Type", "application/json");
  String body = String("{\"station\":\"") + STATION_ID + "\",\"rssi\":" + rssi + "}";
  httpCode = http.POST(body);
  if (httpCode == 200) {
    // 서버 응답 예: {"here":true,"best":"STATION_06","floor":6}
    String res = http.getString();
    isHere = res.indexOf("\"here\":true") >= 0;
    int b = res.indexOf("\"best\":\"");
    nearest = b >= 0 ? res.substring(b + 8, res.indexOf('"', b + 8)) : "-";
    int f = res.indexOf("\"floor\":");
    nearestFloor = f >= 0 ? res.substring(f + 8).toInt() : 0;
  }
  Serial.printf("[%s] %d dBm -> HTTP %d %s\n", STATION_ID, rssi, httpCode, isHere ? "HERE" : "");
  http.end();
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcdLine(0, "DGU Indoor Nav");
  lcdLine(1, STATION_ID);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), onButton, FALLING);

  WiFi.mode(WIFI_STA);
  connectWiFi();

  BLEDevice::init("");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new BeaconCallback(), true);
  pBLEScan->setActiveScan(true);
  pBLEScan->setInterval(100);
  pBLEScan->setWindow(99);
}

void loop() {
  connectWiFi();
  checkDiscovery();

  scanFound = false;
  pBLEScan->start(1, false);   // 1초 스캔
  pBLEScan->clearResults();

  if (scanFound) {
    lastRssi = scanRssi;
    lastSeenMs = millis();
    if (WiFi.status() == WL_CONNECTED && serverBase != "") sendRssi(lastRssi);
  } else if (millis() - lastSeenMs > 4000) {
    isHere = false;
  }

  if (btnPressed) {
    btnPressed = false;
    page = (page + 1) % PAGES;
  }
  drawLCD();
}
