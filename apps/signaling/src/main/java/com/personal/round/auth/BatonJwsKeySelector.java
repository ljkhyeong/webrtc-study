package com.personal.round.auth;

import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.proc.JWSKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import java.security.Key;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

final class BatonJwsKeySelector implements JWSKeySelector<SecurityContext> {

	private static final Pattern KEY_ID_PATTERN =
			Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");

	private final JWSKeySelector<SecurityContext> delegate;

	BatonJwsKeySelector(JWSKeySelector<SecurityContext> delegate) {
		this.delegate = Objects.requireNonNull(delegate, "delegate must not be null");
	}

	@Override
	public List<? extends Key> selectJWSKeys(
			JWSHeader header,
			SecurityContext context)
			throws KeySourceException {
		String keyId = header.getKeyID();
		if (keyId == null || !KEY_ID_PATTERN.matcher(keyId).matches()) {
			return List.of();
		}

		return delegate.selectJWSKeys(header, context);
	}
}
