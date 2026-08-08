package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.proc.JWSKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import java.security.Key;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

class BatonJwsKeySelectorTest {

	private final JWSKeySelector<SecurityContext> delegate = mock();
	private final BatonJwsKeySelector selector = new BatonJwsKeySelector(delegate);

	@ParameterizedTest
	@NullSource
	@ValueSource(strings = {"", " ", "\t"})
	@DisplayName("kid가 없거나 공백이면 공개키를 조회하지 않고 거부한다")
	void rejectsMissingOrBlankKeyIdsBeforeKeyLookup(String keyId) {
		assertThatThrownBy(() -> selector.selectJWSKeys(header(keyId), null))
				.isInstanceOf(KeySourceException.class)
				.hasMessageContaining("invalid key identifier");

		verifyNoInteractions(delegate);
	}

	@ParameterizedTest
	@ValueSource(strings = {
		"../baton-key",
		"baton signing key",
		"한글-key",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				+ "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	})
	@DisplayName("kid가 안전한 BATON 식별자 형식이 아니면 공개키를 조회하지 않고 거부한다")
	void rejectsMalformedKeyIdsBeforeKeyLookup(String keyId) {
		assertThatThrownBy(() -> selector.selectJWSKeys(header(keyId), null))
				.isInstanceOf(KeySourceException.class)
				.hasMessageContaining("invalid key identifier");

		verifyNoInteractions(delegate);
	}

	@Test
	@DisplayName("JWK Set에 일치하는 공개키가 없으면 지원하지 않는 kid로 거부한다")
	void rejectsAnUnsupportedKeyId() throws Exception {
		when(delegate.selectJWSKeys(any(), isNull())).thenReturn(List.of());

		assertThatThrownBy(() -> selector.selectJWSKeys(
				header("retired-baton-key"),
				null))
				.isInstanceOf(KeySourceException.class)
				.hasMessageContaining("No supported BATON signing key");
	}

	@Test
	@DisplayName("유효한 kid와 일치하는 공개키는 기존 RS256 검증기로 전달한다")
	void returnsKeysSelectedByTheRs256Delegate() throws Exception {
		Key key = mock(Key.class);
		List<Key> selectedKeys = List.of(key);
		BatonJwsKeySelector acceptingSelector = new BatonJwsKeySelector(
				(header, context) -> selectedKeys);

		assertThat(acceptingSelector.selectJWSKeys(
				header("baton-key-2026-08"),
				null))
				.isSameAs(selectedKeys);
	}

	private static JWSHeader header(String keyId) {
		JWSHeader.Builder header = new JWSHeader.Builder(JWSAlgorithm.RS256);
		if (keyId != null) {
			header.keyID(keyId);
		}
		return header.build();
	}
}
