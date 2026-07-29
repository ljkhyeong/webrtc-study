package com.personal.round.turn;

import com.personal.round.net.HttpOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

/**
 * Rejects browser-driven cross-origin credential issuance before it consumes quota.
 *
 * <p>This is a browser boundary defense, not client authentication. Non-browser clients can
 * construct these headers and must eventually be replaced by BATON identity and meeting access
 * checks.
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
		if (origin == null || origin.isBlank()) {
			return false;
		}

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
