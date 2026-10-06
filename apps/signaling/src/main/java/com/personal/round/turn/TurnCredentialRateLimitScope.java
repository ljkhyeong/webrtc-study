package com.personal.round.turn;

// 소문자 상수 이름이 round.turn.credentials.rate_limited 지표의 scope 태그다.
// 해제 시점이 같은 거부가 겹치면 뒤에 선언한 범위를 보고한다. 순서는 서버 README 설명과 같아야 한다.
enum TurnCredentialRateLimitScope {
	CLIENT,
	PARTICIPANT,
	GLOBAL,
	CLIENT_STATE_CAPACITY,
	PARTICIPANT_STATE_CAPACITY
}
