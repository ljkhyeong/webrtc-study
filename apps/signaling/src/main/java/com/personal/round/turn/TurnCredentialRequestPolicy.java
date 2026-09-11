package com.personal.round.turn;

import com.personal.round.net.HttpOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

/**
 * 브라우저에서 시작된 교차 출처 자격 증명 발급 요청이 할당량을 사용하기 전에 거부한다.
 *
 * <p>다른 사이트의 브라우저 요청을 막기 위한 검사이며 클라이언트 자체를 인증하지는 않는다. BATON 모드에서는 Spring Security와
 * 방 참여권이 인증과 권한 부여를 담당한다. 이 정책은 TURN 할당량 사용 전 동일 출처 방어로 유지한다.
 */
@Component
final class TurnCredentialRequestPolicy {

	private static final String FETCH_SITE_HEADER = "Sec-Fetch-Site";
	private static final String SAME_ORIGIN = "same-origin";

	boolean allows(HttpServletRequest request) {
		String fetchSite = request.getHeader(FETCH_SITE_HEADER);
		if (fetchSite != null && !SAME_ORIGIN.equalsIgnoreCase(fetchSite.trim())) {
			return false;
		}

		String origin = request.getHeader(HttpHeaders.ORIGIN);
		try {
			return HttpOrigin.parse(origin)
					.matches(
							request.getScheme(),
							request.getServerName(),
							request.getServerPort());
		}
		catch (IllegalArgumentException ignored) {
			return false;
		}
	}
}
