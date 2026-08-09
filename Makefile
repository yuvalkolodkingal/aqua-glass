UUID      := aqua-glass@yuvalkolodkingal.github.io
SRC       := src
BUILD     := build
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

SOURCES := $(SRC)/extension.js $(SRC)/prefs.js $(SRC)/metadata.json \
           $(SRC)/stylesheet.css $(wildcard $(SRC)/lib/*.js)

.PHONY: all check schemas install uninstall zip enable disable logs selfcheck memtest clean

all: check schemas

## Syntax-check every JavaScript file, validate the schema, run the unit tests.
check: lint schema-check test

## Parse every file as an ES module. node treats .js as CommonJS, where a
## top-level `import` is a syntax error, so each file is checked as .mjs.
lint:
	@echo "==> Syntax check"
	@tmp=$$(mktemp -d); ok=1; \
	for f in $(SRC)/extension.js $(SRC)/prefs.js $(SRC)/lib/*.js; do \
	  cp "$$f" "$$tmp/$$(basename $$f .js).mjs"; \
	  if node --check "$$tmp/$$(basename $$f .js).mjs" 2>"$$tmp/err"; then \
	    echo "  ok   $$f"; \
	  else \
	    echo "  FAIL $$f"; sed -n '1,8p' "$$tmp/err"; ok=0; \
	  fi; \
	done; \
	rm -rf "$$tmp"; test $$ok -eq 1

schema-check:
	@echo "==> Validating GSettings schema"
	@glib-compile-schemas --strict --dry-run $(SRC)/schemas
	@echo "==> Validating metadata.json"
	@python3 -c "import json; json.load(open('$(SRC)/metadata.json'))"

## Unit-test the colour science and the shader's light convention. Both
## modules are pure JavaScript with no GI imports, so they run under plain node.
test:
	@echo "==> Unit tests"
	@node tests/run.mjs

## Compile the settings schema in place.
schemas:
	@glib-compile-schemas $(SRC)/schemas
	@echo "==> Compiled $(SRC)/schemas/gschemas.compiled"

install: schemas
	@echo "==> Installing to $(INSTALL_DIR)"
	@rm -rf "$(INSTALL_DIR)"
	@mkdir -p "$(INSTALL_DIR)"
	@cp -r $(SRC)/. "$(INSTALL_DIR)/"
	@echo "==> Installed. Log out and back in (Wayland), then:"
	@echo "    gnome-extensions enable $(UUID)"

uninstall:
	@./uninstall.sh

zip: schemas
	@rm -rf $(BUILD) && mkdir -p $(BUILD)
	@cd $(SRC) && zip -qr ../$(BUILD)/$(UUID).zip .
	@echo "==> $(BUILD)/$(UUID).zip"

enable:
	@gnome-extensions enable $(UUID)

disable:
	@gnome-extensions disable $(UUID)

logs:
	@journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered aqua-glass

## Print the runtime self-check report.
selfcheck:
	@gdbus call --session --dest org.gnome.Shell \
	  --object-path /org/gnome/Shell/Extensions/AquaGlass \
	  --method org.gnome.Shell.Extensions.AquaGlass.SelfCheck \
	  | sed -e "s/^('//" -e "s/',)$$//" -e 's/\\n/\n/g'

## Open and close 50 menus and report the RSS delta.
memtest:
	@gdbus call --session --timeout 180 --dest org.gnome.Shell \
	  --object-path /org/gnome/Shell/Extensions/AquaGlass \
	  --method org.gnome.Shell.Extensions.AquaGlass.MemoryTest 50 \
	  | sed -e "s/^('//" -e "s/',)$$//" -e 's/\\n/\n/g'

clean:
	@rm -rf $(BUILD) $(SRC)/schemas/gschemas.compiled
