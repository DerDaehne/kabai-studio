{
  description = "kabai studio - agent orchestration studio (tickets as executable agent jobs)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # Playwright's downloaded Chromium misses shared libraries on NixOS; the browser suite uses this one instead.
        browser = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.chromium ];
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            git
          ] ++ browser;
          STUDIO_BROWSER_EXECUTABLE = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.chromium}/bin/chromium";
        };
      }
    );
}
