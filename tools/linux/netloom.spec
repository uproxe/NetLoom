# Пакет .rpm из уже собранного дерева файлов (то же, что в .deb).
# Собирает tools/package.sh: rpmbuild -bb --define "nl_version …" --define "nl_root …" netloom.spec
Name:           netloom
Version:        %{nl_version}
Release:        1
Summary:        Приватный браузер со встроенным VPN и блокировкой рекламы
License:        MPL-2.0
URL:            https://github.com/uproxe/NetLoom
BuildArch:      x86_64
# движок несёт свои библиотеки (NSS и др.) — зависимости задаём сами, по именам библиотек:
# так они одинаково понятны Fedora, РЕД ОС, РОСА и openSUSE
AutoReqProv:    no
Requires:       libgtk-3.so.0()(64bit)
Requires:       libasound.so.2()(64bit)
Requires:       libdbus-1.so.3()(64bit)
Requires:       libX11-xcb.so.1()(64bit)
Requires:       libXtst.so.6()(64bit)
Provides:       webclient

%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none
%define _binary_payload w6.xzdio
%define _build_name_fmt %%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm

%description
NetLoom — браузер на движке Gecko со своим минимальным интерфейсом:
вкладки, адресная строка и панель закладок. Встроенная блокировка
рекламы (базы AdGuard и EasyList), VPN и прокси (VLESS, VMess, Trojan,
Shadowsocks, Hysteria2, TUIC, WireGuard, SOCKS5, HTTP), защита от
опасных сайтов без Google. Без аккаунтов и телеметрии.

%install
mkdir -p %{buildroot}
cp -a %{nl_root}/usr %{buildroot}/

%post
update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || :
gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || :

%postun
update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || :
gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || :

%files
/usr/lib/netloom
/usr/bin/netloom
/usr/share/applications/netloom.desktop
/usr/share/icons/hicolor/*/apps/netloom.*
/usr/share/doc/netloom
