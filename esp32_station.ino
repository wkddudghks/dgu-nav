/*
 * 실내 내비게이션 - ESP32 스테이션 코드 (스테이션마다 STATION_ID만 바꿔서 업로드)
 * 역할: 스마트폰 iBeacon 신호를 BLE로 스캔 → RSSI(신호세기)를 Wi-Fi로 서버에 전송
 *
 * 서버 자동 찾기: 노트북 서버가 2초마다 "DGU-NAV 3001"을 방송하면 그걸 듣고 서버 IP를 알아냅니다.
 *  → 핫스팟을 껐다 켜서 노트북 IP가 바뀌어도 다시 업로드할 필요 없음
 *
 * 클라우드 모드: CLOUD_URL에 Render 주소를 넣으면 노트북 없이 인터넷 서버로 바로 보냄
 *  (이때 와이파이는 인터넷이 되는 곳이어야 하고, DEVICE_KEY는 Render에 넣은 값과 같아야 함)
 *
 * Arduino IDE 설정
 *  - 보드: "ESP32 Dev Module" (보드 매니저에서 esp32 by Espressif 설치)
 *  - Tools > Partition Scheme > "Huge APP (3MB No OTA)"  ← BLE+WiFi 같이 쓰면 용량 부족하므로 필수
 *  - Serial Monitor 115200
 */
#include <WiFi.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <esp_bt.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

// ======== 바꿀 부분 ========
const char* STATION_ID = "STATION_01";   // 보드마다 STATION_01, 02, 03, 04 ...
const char* WIFI_SSID  = "hotspot-name";  // 와이파이 이름 (2.4GHz, 영어 이름)
const char* WIFI_PASS  = "hotspot-pass";  // 핫스팟 비밀번호
// 자동 찾기가 안 될 때 쓸 노트북 주소 (ipconfig의 IPv4). 자동 찾기만 쓰려면 "" 로 두기
const char* SERVER_IP  = "172.30.1.93";

// 클라우드 서버 (비워 두면 노트북 서버 사용)
const char* CLOUD_URL  = "";              // 예) "https://dgu-nav.onrender.com"
const char* DEVICE_KEY = "";              // Render 환경변수 DEVICE_KEY와 같은 값

// 비콘 앱에서 설정한 Major / Minor 값
const uint16_t TARGET_MAJOR = 123;
const uint16_t TARGET_MINOR = 123;

// 신호 세기 → 거리 변환 (서버 server.js의 TX_POWER, N_EXP와 같게)
const float TX_POWER = -59;   // 폰을 1m 떨어뜨렸을 때 RSSI
const float N_EXP    = 2.5;   // 탁 트인 곳 2.0, 복도/벽 많으면 2.5~3.0
// ===========================

const uint16_t DISCOVERY_PORT = 4210;
WiFiUDP udp;
String serverBase = "";      // 자동으로 찾은 서버 주소 예) http://172.20.10.2:3001
int discoveryTries = 0;
int failCount = 0;
WiFiClientSecure secureClient;
WiFiClient plainClient;
HTTPClient http;
bool cloudMode() { return strlen(CLOUD_URL) > 0; }

volatile int  latestRssi = 0;
volatile bool found = false;
BLEScan* pBLEScan;

// iBeacon 광고 패킷 구조:
// [0-1] 4C 00 (Apple)  [2] 02  [3] 15  [4-19] UUID  [20-21] Major  [22-23] Minor  [24] TxPower
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

    // MAC 주소가 아니라 Major/Minor로 구분 → 아이폰의 랜덤 MAC 문제 해결
    latestRssi = dev.getRSSI();
    found = true;
  }
};

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("WiFi 연결 중");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(250);
    Serial.print(".");
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" 성공: " + WiFi.localIP().toString());
    udp.stop();
    udp.begin(DISCOVERY_PORT);       // 서버 방송 듣기 시작
  } else {
    Serial.println(" 실패 (핫스팟 이름/비밀번호/2.4GHz 확인)");
  }
}

// 서버가 보낸 "DGU-NAV 3001" 메시지를 읽어서 서버 주소를 갱신
void checkDiscovery() {
  while (udp.parsePacket() > 0) {
    char buf[32];
    int len = udp.read(buf, sizeof(buf) - 1);
    if (len <= 0) continue;
    buf[len] = 0;
    if (strncmp(buf, "DGU-NAV ", 8) != 0) continue;
    String base = "http://" + udp.remoteIP().toString() + ":" + String(atoi(buf + 8));
    if (base != serverBase) {
      serverBase = base;
      Serial.println("서버 찾음: " + serverBase);
    }
  }
}

void sendRssi(int rssi) {
  String url = serverBase + "/rssi";
  http.setReuse(true);                       // 연결을 재사용해서 https도 빠르게
  if (url.startsWith("https")) http.begin(secureClient, url);
  else                          http.begin(plainClient, url);
  http.setTimeout(cloudMode() ? 8000 : 1500); // 클라우드는 잠에서 깨는 데 시간이 걸림
  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_KEY)) http.addHeader("X-Device-Key", DEVICE_KEY);
  String body = String("{\"station\":\"") + STATION_ID + "\",\"rssi\":" + rssi + "}";
  int code = http.POST(body);
  float meters = pow(10, (TX_POWER - rssi) / (10 * N_EXP));
  Serial.printf("[%s] RSSI %d dBm (약 %.1fm) -> HTTP %d\n", STATION_ID, rssi, meters, code);
  http.end();
  // 계속 실패하면 노트북 IP가 바뀐 것일 수 있으니 다시 찾기
  if (code == 401) Serial.println("  → DEVICE_KEY가 서버와 달라요");
  if (!cloudMode() && code < 0 && ++failCount >= 5) { Serial.println("서버 응답 없음 → 다시 찾기"); serverBase = ""; discoveryTries = 0; failCount = 0; }
  if (code > 0) failCount = 0;
}

void setup() {
  Serial.begin(115200);
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);   // 안 쓰는 클래식 블루투스 메모리 반납 (https용 메모리 확보)
  secureClient.setInsecure();                              // 인증서 검사 생략 (과제용)
  WiFi.mode(WIFI_STA);
  connectWiFi();
  if (cloudMode()) { serverBase = CLOUD_URL; Serial.println("클라우드 모드: " + serverBase); }

  BLEDevice::init("");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new BeaconCallback(), true); // true = 같은 기기도 계속 보고
  pBLEScan->setActiveScan(true);
  pBLEScan->setInterval(100);
  pBLEScan->setWindow(99);
}

void loop() {
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return;

  // 서버를 아직 모르면: 블루투스 스캔을 멈추고 3초 동안 서버 방송만 듣기
  // (스캔 중에는 와이파이 수신이 거의 안 돼서 방송을 놓침)
  if (serverBase == "") {
    Serial.println("서버 찾는 중... (노트북에서 node server.js 실행했는지 확인)");
    unsigned long t0 = millis();
    while (serverBase == "" && millis() - t0 < 3000) { checkDiscovery(); delay(20); }
    if (serverBase == "" && ++discoveryTries >= 2 && strlen(SERVER_IP) > 0) {
      serverBase = String("http://") + SERVER_IP + ":3001";
      Serial.println("자동 찾기 실패 → 직접 입력한 주소 사용: " + serverBase);
    }
    if (serverBase == "") return;
  }
  checkDiscovery();

  found = false;
  pBLEScan->start(1, false);   // 1초 스캔
  pBLEScan->clearResults();

  if (found) sendRssi(latestRssi);
}
