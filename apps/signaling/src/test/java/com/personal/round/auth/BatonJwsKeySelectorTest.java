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
import com.nimbusds.jose.jwk.source.RateLimitReachedException;
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
	private final BatonJwsKeySelector selector =
			new BatonJwsKeySelector(delegate, () -> false);

	@ParameterizedTest
	@NullSource
	@ValueSource(strings = {"", " ", "\t"})
	@DisplayName("kid가 없거나 공백이면 공개키를 조회하지 않고 거부한다")
	void rejectsMissingOrBlankKeyIdsBeforeKeyLookup(String keyId) throws Exception {
		assertThat(selector.selectJWSKeys(header(keyId), null)).isEmpty();

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
	void rejectsMalformedKeyIdsBeforeKeyLookup(String keyId) throws Exception {
		assertThat(selector.selectJWSKeys(header(keyId), null)).isEmpty();

		verifyNoInteractions(delegate);
	}

	@Test
	@DisplayName("JWK Set에 일치하는 공개키가 없으면 지원하지 않는 kid로 거부한다")
	void rejectsAnUnsupportedKeyId() throws Exception {
		when(delegate.selectJWSKeys(any(), isNull())).thenReturn(List.of());

		assertThat(selector.selectJWSKeys(
				header("retired-baton-key"),
				null))
				.isEmpty();
	}

	@Test
	@DisplayName("JWK 재조회 제한에 도달하면 지원하지 않는 kid로 거부한다")
	void rejectsAKeyIdWhenTheJwkRefreshRateLimitIsReached() throws Exception {
		when(delegate.selectJWSKeys(any(), isNull()))
				.thenThrow(new RateLimitReachedException());

		assertThat(selector.selectJWSKeys(
				header("unknown-baton-key"),
				null))
				.isEmpty();
	}

	@Test
	@DisplayName("최근 JWK 원격 조회가 실패했으면 재조회 제한도 인프라 장애로 전달한다")
	void propagatesTheRateLimitAfterAJwkSourceFailure() throws Exception {
		RateLimitReachedException failure = new RateLimitReachedException();
		when(delegate.selectJWSKeys(any(), isNull())).thenThrow(failure);
		BatonJwsKeySelector unavailableSelector = new BatonJwsKeySelector(
				delegate,
				() -> true);

		assertThatThrownBy(() -> unavailableSelector.selectJWSKeys(
				header("baton-key-during-outage"),
				null))
				.isSameAs(failure);
	}

	@Test
	@DisplayName("JWK 원격 조회 장애는 인증 실패로 숨기지 않고 전달한다")
	void propagatesOtherKeySourceFailures() throws Exception {
		KeySourceException failure = new KeySourceException("JWK endpoint unavailable");
		when(delegate.selectJWSKeys(any(), isNull())).thenThrow(failure);

		assertThatThrownBy(() -> selector.selectJWSKeys(
				header("baton-key-2026-08"),
				null))
				.isSameAs(failure);
	}

	@Test
	@DisplayName("유효한 kid와 일치하는 공개키는 기존 RS256 검증기로 전달한다")
	void returnsKeysSelectedByTheRs256Delegate() throws Exception {
		Key key = mock(Key.class);
		List<Key> selectedKeys = List.of(key);
		BatonJwsKeySelector acceptingSelector = new BatonJwsKeySelector(
				(header, context) -> selectedKeys,
				() -> false);

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
