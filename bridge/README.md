# Android Bridge ↔ Termux

이 디렉터리는 Loco 직접 로그인 대신 **Android 쪽에서 전달된 이벤트를 Termux 봇으로 중계**하기 위한 브리지 계약을 정의합니다.

## 이벤트 형식

Bridge → Termux:

```json
{"type":"chat","room":"테스트방","user":{"id":"123","name":"우빈"},"text":"!명령어","timestamp":1720000000000}
```

```json
{"type":"member_join","room":"테스트방","user":{"id":"123","name":"우빈"},"timestamp":1720000000000}
```

```json
{"type":"member_leave","room":"테스트방","user":{"id":"123","name":"우빈"},"timestamp":1720000000000}
```

Termux → Bridge 응답:

```json
{"type":"send_message","room":"테스트방","text":"안녕하세요"}
```

중요: Android Bridge는 카카오톡의 보호된 내부 통신을 후킹/복호화하지 않습니다. Android에서 합법적으로 접근 가능한 이벤트만 이 인터페이스로 전달해야 합니다.
