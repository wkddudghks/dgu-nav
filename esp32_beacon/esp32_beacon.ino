/*
 * ESP32를 iBeacon(비콘)으로 만들기 — 폰의 비콘 앱 대신 사용
 *
 * - 폰 앱과 똑같은 iBeacon 신호(Major 123 / Minor 123)를 0.1초마다 보냄
 * - 스테이션 코드는 바꿀 필요 없음 (Major/Minor만 같으면 폰인지 ESP32인지 구분 안 함)
 * - 보조배터리에 꽂아서 들고 다니면 "위치 태그"가 됨
 * - 이 보드는 스테이션으로 쓰지 말 것 (비콘 전용)
 *
 * Arduino IDE: 보드 ESP32 Dev Module / Partition Scheme: Huge APP
 * 라이브러리 설치 필요 없음 (esp32 보드 패키지에 포함)
 * 동작 확인: 보드의 파란 LED가 1초마다 깜빡이면 신호를 보내는 중
 */
#include <BLEDevice.h>
#include <BLEBeacon.h>
#include <BLEAdvertising.h>

// ======== 바꿀 부분 ========
const uint16_t MAJOR = 123;     // 스테이션 코드의 TARGET_MAJOR와 같게
const uint16_t MINOR = 123;     // 스테이션 코드의 TARGET_MINOR와 같게
const int8_t   MEASURED_POWER = -59;   // 1m에서의 신호 세기 (참고용 값)
// ===========================

const int LED_PIN = 2;          // 대부분의 ESP32 DevKit 내장 LED

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  BLEDevice::init("DGU-Beacon");

  BLEBeacon beacon;
  beacon.setManufacturerId(0x4C00);   // Apple iBeacon 형식
  beacon.setProximityUUID(BLEUUID("fda50693-a4e2-4fb1-afcf-c6eb07647825"));

  // iBeacon 데이터(25바이트)를 직접 채워서 바이트 순서 문제를 없앰
  //  [0-1] 4C 00  [2] 02  [3] 15  [4-19] UUID  [20-21] Major  [22-23] Minor  [24] 1m 신호 세기
  auto data = beacon.getData();
  data[0] = 0x4C; data[1] = 0x00; data[2] = 0x02; data[3] = 0x15;
  data[20] = (char)(MAJOR >> 8); data[21] = (char)(MAJOR & 0xFF);
  data[22] = (char)(MINOR >> 8); data[23] = (char)(MINOR & 0xFF);
  data[24] = (char)MEASURED_POWER;

  BLEAdvertisementData adv;
  adv.setFlags(0x04);                 // BLE 전용 기기
  adv.setManufacturerData(data);

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->setAdvertisementData(adv);
  advertising->setScanResponseData(BLEAdvertisementData());
  advertising->setMinInterval(160);   // 160 × 0.625ms = 100ms 마다 신호
  advertising->setMaxInterval(160);
  advertising->start();

  Serial.printf("비콘 시작: Major %u / Minor %u\n", MAJOR, MINOR);
}

void loop() {
  digitalWrite(LED_PIN, HIGH); delay(80);
  digitalWrite(LED_PIN, LOW);  delay(920);
}
