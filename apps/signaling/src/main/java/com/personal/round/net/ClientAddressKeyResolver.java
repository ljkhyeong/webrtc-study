package com.personal.round.net;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.regex.Pattern;

/**
 * 유효 원격 주소에서 남용 제어용 키 하나를 만든다.
 *
 * <p>IPv4 클라이언트는 전체 주소를 유지한다. IPv6 클라이언트는 /64마다 하나의 키를 공유하므로
 * 인터페이스 식별자를 회전해도 연결, 시그널링 프레임, TURN 발급 제한을 초기화할 수 없다. 숫자 형식이
 * 아니거나 잘못된 값은 DNS 조회를 시작하지 않고 하나의 공유 미확인 클라이언트 버킷에 보수적으로 묶는다.
 */
public final class ClientAddressKeyResolver {

	static final String UNKNOWN_CLIENT = "<unknown>";
	private static final Pattern IPV6_LITERAL_CHARACTERS =
			Pattern.compile("[0-9A-Fa-f:.]+");

	private ClientAddressKeyResolver() {
	}

	public static String resolve(String remoteAddress) {
		if (remoteAddress == null) {
			return UNKNOWN_CLIENT;
		}
		String candidate = remoteAddress.trim();
		if (candidate.length() > 1 && candidate.startsWith("[") && candidate.endsWith("]")) {
			candidate = candidate.substring(1, candidate.length() - 1);
		}
		int zoneSeparator = candidate.indexOf('%');
		if (zoneSeparator >= 0) {
			candidate = candidate.substring(0, zoneSeparator);
		}
		if (candidate.isEmpty()) {
			return UNKNOWN_CLIENT;
		}

		byte[] ipv4 = parseIpv4(candidate);
		if (ipv4 != null) {
			return key(ipv4);
		}
		if (!candidate.contains(":")
				|| !IPV6_LITERAL_CHARACTERS.matcher(candidate).matches()) {
			return UNKNOWN_CLIENT;
		}
		try {
			return key(InetAddress.getByName(candidate).getAddress());
		}
		catch (UnknownHostException ignored) {
			return UNKNOWN_CLIENT;
		}
	}

	// 입력 배열은 parseIpv4가 새로 만들거나 InetAddress.getAddress()가 복제해 돌려준 값이다.
	private static String key(byte[] address) {
		try {
			if (address.length == 4) {
				return "ipv4:" + InetAddress.getByAddress(address).getHostAddress();
			}
			Arrays.fill(address, 8, address.length, (byte) 0);
			return "ipv6:" + InetAddress.getByAddress(address).getHostAddress() + "/64";
		}
		catch (UnknownHostException impossible) {
			throw new IllegalStateException("A 4- or 16-byte address must be valid", impossible);
		}
	}

	private static byte[] parseIpv4(String candidate) {
		String[] octets = candidate.split("\\.", -1);
		if (octets.length != 4) {
			return null;
		}
		byte[] address = new byte[4];
		for (int index = 0; index < octets.length; index++) {
			String octet = octets[index];
			if (octet.isEmpty() || octet.length() > 3) {
				return null;
			}
			int value = 0;
			for (int characterIndex = 0; characterIndex < octet.length(); characterIndex++) {
				char character = octet.charAt(characterIndex);
				if (character < '0' || character > '9') {
					return null;
				}
				value = value * 10 + character - '0';
			}
			if (value > 255) {
				return null;
			}
			address[index] = (byte) value;
		}
		return address;
	}
}
