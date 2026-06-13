# SSH 통합 테스트용 sshd 컨테이너.
#
# alpine 베이스에 openssh + rsync 를 직접 설치 — 서드파티 sshd 이미지의
# 환경 변수/볼륨 quirk 를 피하고 재현성을 확보한다.
#
# 유저:
#   - duet / duetpass  (메인 테스트 유저, authorized key 도 주입)
#   - alt  / altpass   (same-host different-user 시나리오 옵션용)
FROM alpine:3.20

RUN apk add --no-cache openssh-server rsync netcat-openbsd \
 && ssh-keygen -A \
 && mkdir -p /run/sshd /var/empty \
 && adduser -D duet && echo 'duet:duetpass' | chpasswd \
 && adduser -D alt  && echo 'alt:altpass'   | chpasswd

# 테스트용 authorized key 주입 (키 인증 커버리지). 빌드 컨텍스트의 keys/ 는
# scripts/ssh-it.sh 가 빌드 전에 생성한다.
COPY keys/id_ed25519.pub /home/duet/.ssh/authorized_keys
RUN chown -R duet:duet /home/duet/.ssh \
 && chmod 700 /home/duet/.ssh \
 && chmod 600 /home/duet/.ssh/authorized_keys

# 비밀번호 인증 허용, root 로그인 차단.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config

EXPOSE 22

# 포그라운드(-D) + stderr 로그(-e).
CMD ["/usr/sbin/sshd", "-D", "-e"]
