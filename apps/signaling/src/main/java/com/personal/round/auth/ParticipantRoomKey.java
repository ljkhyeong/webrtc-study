package com.personal.round.auth;

/** 같은 방의 같은 BATON 사용자를 묶는 연결·발급 제한 키다. 사용자 식별 정보는 문자열로 남기지 않는다. */
public record ParticipantRoomKey(
		String roomId,
		String subject) {

	@Override
	public String toString() {
		return "ParticipantRoomKey[redacted]";
	}
}
