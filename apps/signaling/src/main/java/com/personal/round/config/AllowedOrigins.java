package com.personal.round.config;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.List;
import java.util.Set;

/**
 * 설정한 허용 출처를 실행 모드에 맞게 시작 시 검증한다. 요청의 Origin 비교는 Spring의
 * WebSocket 등록 설정과 {@code CorsConfiguration}이 맡는다.
 */
final class AllowedOrigins {

	private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "[::1]");

	private AllowedOrigins() {
	}

	static List<String> validate(List<String> configuredOrigins, SecurityMode securityMode) {
		if (configuredOrigins.isEmpty()) {
			throw new IllegalArgumentException("At least one allowed origin is required");
		}
		for (String origin : configuredOrigins) {
			if ("*".equals(origin) || "null".equals(origin)) {
				if (securityMode != SecurityMode.DEVELOPMENT) {
					throw new IllegalArgumentException(
							("*".equals(origin) ? "Wildcard origins" : "The null origin")
									+ " are forbidden in production and BATON modes");
				}
				continue;
			}
			URI uri = parse(origin);
			boolean https = "https".equalsIgnoreCase(uri.getScheme());
			if (securityMode.requiresHttps() && !https) {
				throw new IllegalArgumentException("Production origins must use HTTPS");
			}
			if (securityMode == SecurityMode.BATON_DEVELOPMENT
					&& !https
					&& !LOOPBACK_HOSTS.contains(uri.getHost())) {
				throw new IllegalArgumentException("BATON origins must use HTTPS or loopback HTTP");
			}
		}
		return List.copyOf(configuredOrigins);
	}

	private static URI parse(String origin) {
		try {
			URI uri = new URI(origin);
			String path = uri.getRawPath();
			if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
					|| uri.getHost() == null
					|| uri.getRawUserInfo() != null
					|| uri.getRawQuery() != null
					|| uri.getRawFragment() != null
					|| !(path == null || path.isEmpty() || "/".equals(path))) {
				throw new IllegalArgumentException("Allowed origins must contain only an HTTP scheme, host, and port");
			}
			return uri;
		}
		catch (URISyntaxException exception) {
			throw new IllegalArgumentException("Allowed origin is not a valid URI", exception);
		}
	}

	enum SecurityMode {
		DEVELOPMENT,
		STANDALONE_PRODUCTION,
		BATON_DEVELOPMENT,
		BATON_PRODUCTION;

		static SecurityMode from(boolean production, boolean batonMode) {
			if (batonMode) {
				return production ? BATON_PRODUCTION : BATON_DEVELOPMENT;
			}
			return production ? STANDALONE_PRODUCTION : DEVELOPMENT;
		}

		private boolean requiresHttps() {
			return this == STANDALONE_PRODUCTION || this == BATON_PRODUCTION;
		}
	}
}
