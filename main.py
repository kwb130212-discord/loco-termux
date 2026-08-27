import getpass
import logging
import sys
import traceback
import requests

# 1. 로컬 오류 로그 파일 설정
logging.basicConfig(
    filename="bot_error.log",
    level=logging.ERROR,
    format="%(asctime)s - %(levelname)s - %(message)s",
)


def send_webhook_alert(webhook_url, error_message):
  """오류 발생 시 사용자가 지정한 웹훅(디스코드 등)으로 로그 전송"""
  if not webhook_url:
    return
  payload = {
      "content": (
          "🚨 **[봇 오류 발생 알림]**\n```python\n"
          f"{error_message[:1900]}\n```"
      )
  }
  try:
    requests.post(webhook_url, json=payload, timeout=5)
  except Exception as e:
    print(f"웹훅 전송 실패: {e}")


def run_tutorial():
  """튜토리얼 단계"""
  print("\n[+] 튜토리얼을 시작합니다.")
  print(
      " - 이 프로그램은 Termux 및 일반 콘솔 환경에서 모두 동작하도록"
      " 설계되었습니다."
  )
  print(
      " - 로그인 정보는 안전하게 처리되며, 커스텀 스크립트 실행을 위한 세션에"
      " 활용됩니다."
  )
  input("\n튜토리얼을 마치려면 Enter 키를 누르세요...")


def custom_script():
  """커스텀 스크립트 작성 영역"""
  print("\n[+] 커스텀 스크립트 실행 중...")
  # TODO: 이곳에 원하시는 메신저 프로토콜 연동이나 자동화 로직을 작성하세요.

  # 예시 테스트용 에러 유발 코드 (필요시 삭제 후 실제 로직 작성)
  # raise ValueError("커스텀 스크립트 실행 중 예기치 않은 오류가 발생했습니다!")

  print("[✔] 커스텀 스크립트가 성공적으로 완료되었습니다.")


def main():
  print("========================================")
  print("      Termux Python 봇 프레임워크       ")
  print("========================================")

  # 0. 알림을 받을 웹훅 주소 입력 (선택사항)
  webhook_url = input(
      "오류 알림을 받을 웹훅 URL을 입력하세요 (생략하려면 엔터):"
  ).strip()

  # 1. 이메일 입력
  email = input("이메일을 입력해주세요: ").strip()

  # 2. 비밀번호 입력 (보안을 위해 입력 시 화면에 표시되지 않음)
  password = getpass.getpass("비번을 입력해주세요: ").strip()

  if not email or not password:
    print("[❌ 오류] 이메일과 비밀번호는 필수 입력 항목입니다.")
    sys.exit(1)

  try:
    print(f"[*] 인증 진행 중... ({email})")
    # TODO: 입력받은 계정 정보를 활용한 로그인/세션 수립 로직 추가

    # 3. 튜토리얼 실행
    run_tutorial()

    # 4. 커스텀 스크립트 실행
    custom_script()

  except Exception as e:
    # 5. 오류 발생 시 로그 기록 및 웹훅 전송
    err_msg = traceback.format_exc()
    print(f"\n[❌ 치명적 오류 발생]\n{e}")

    # 로컬 로그 저장
    logging.error(err_msg)

    # 웹훅으로 전송
    if webhook_url:
      print("[*] 웹훅으로 오류 로그를 전송합니다...")
      send_webhook_alert(webhook_url, err_msg)

    sys.exit(1)


if __name__ == "__main__":
  main()
