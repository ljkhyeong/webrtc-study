package com.personal.round.config;

import com.personal.round.net.HttpOrigin;
import java.util.HashSet;
import java.util.Set;

public final class OriginPolicy {

	private final Set<HttpOrigin> allowedOrigins;
	private final boolean allowNull;
	private final boolean allowAny;

	public OriginPolicy(Iterable<String> configuredOrigins) {
		this(configuredOrigins, SecurityMode.DEVELOPMENT);
	}

	public OriginPolicy(
			Iterable<String> configuredOrigins,
			SecurityMode securityMode) {
		Set<HttpOrigin> normalizedOrigins = new HashSet<>();
		boolean wildcard = false;
		boolean nullOrigin = false;
		for (String configuredOrigin : configuredOrigins) {
			if ("*".equals(configuredOrigin)) {
				if (securityMode.forbidsRelaxedOrigins()) {
					throw new IllegalArgumentException(
							"Wildcard origins are forbidden in production and BATON modes");
				}
				wildcard = true;
			}
			else if ("null".equals(configuredOrigin)) {
				if (securityMode.forbidsRelaxedOrigins()) {
					throw new IllegalArgumentException(
							"The null origin is forbidden in production and BATON modes");
				}
				nullOrigin = true;
			}
			else {
				HttpOrigin normalized = HttpOrigin.parseAllowingTrailingSlash(configuredOrigin);
				if (securityMode.requiresHttps()
						&& !"https".equals(normalized.scheme())) {
					throw new IllegalArgumentException(
							"Production origins must use HTTPS");
				}
				if (securityMode.allowsOnlySecureBatonOrigins()
						&& !"https".equals(normalized.scheme())
						&& !isLoopback(normalized.host())) {
					throw new IllegalArgumentException(
							"BATON origins must use HTTPS or loopback HTTP");
				}
				normalizedOrigins.add(normalized);
			}
		}
		if (!wildcard && !nullOrigin && normalizedOrigins.isEmpty()) {
			throw new IllegalArgumentException("At least one allowed origin is required");
		}
		this.allowedOrigins = Set.copyOf(normalizedOrigins);
		this.allowNull = nullOrigin;
		this.allowAny = wildcard;
	}

	private static boolean isLoopback(String host) {
		return "localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host);
	}

	public boolean allows(String origin) {
		if (allowAny) {
			return true;
		}
		if (origin == null) {
			return false;
		}
		if ("null".equals(origin)) {
			return allowNull;
		}
		try {
			return allowedOrigins.contains(HttpOrigin.parseAllowingTrailingSlash(origin));
		}
		catch (IllegalArgumentException ignored) {
			return false;
		}
	}

	public enum SecurityMode {
		DEVELOPMENT,
		STANDALONE_PRODUCTION,
		BATON_DEVELOPMENT,
		BATON_PRODUCTION;

		public static SecurityMode from(boolean production, boolean batonMode) {
			if (batonMode) {
				return production ? BATON_PRODUCTION : BATON_DEVELOPMENT;
			}
			return production ? STANDALONE_PRODUCTION : DEVELOPMENT;
		}

		private boolean forbidsRelaxedOrigins() {
			return this != DEVELOPMENT;
		}

		private boolean requiresHttps() {
			return this == STANDALONE_PRODUCTION || this == BATON_PRODUCTION;
		}

		private boolean allowsOnlySecureBatonOrigins() {
			return this == BATON_DEVELOPMENT;
		}
	}
}
