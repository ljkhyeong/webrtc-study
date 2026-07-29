package com.personal.round.config;

import com.personal.round.net.HttpOrigin;
import java.util.HashSet;
import java.util.Set;

public final class OriginPolicy {

	private final Set<HttpOrigin> allowedOrigins;
	private final boolean allowNull;
	private final boolean allowAny;

	public OriginPolicy(Iterable<String> configuredOrigins) {
		this(configuredOrigins, false);
	}

	public OriginPolicy(Iterable<String> configuredOrigins, boolean production) {
		Set<HttpOrigin> normalizedOrigins = new HashSet<>();
		boolean wildcard = false;
		boolean nullOrigin = false;
		for (String configuredOrigin : configuredOrigins) {
			if ("*".equals(configuredOrigin)) {
				if (production) {
					throw new IllegalArgumentException(
							"Wildcard origins are forbidden in the production profile");
				}
				wildcard = true;
			}
			else if ("null".equals(configuredOrigin)) {
				if (production) {
					throw new IllegalArgumentException(
							"The null origin is forbidden in the production profile");
				}
				nullOrigin = true;
			}
			else {
				HttpOrigin normalized = HttpOrigin.parseAllowingTrailingSlash(configuredOrigin);
				if (production && !"https".equals(normalized.scheme())) {
					throw new IllegalArgumentException(
							"Production origins must use HTTPS");
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
}
