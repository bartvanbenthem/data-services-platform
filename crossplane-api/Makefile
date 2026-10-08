.PHONY: generate check test install uninstall

# Rebuild apis/postgrescluster/composition.yaml from composition.tmpl.yaml + src/
generate:
	python3 hack/generate.py

# Fail if composition.yaml is stale
check:
	python3 hack/generate.py --check

# Offline render + schema validation tests (needs crossplane CLI + Docker/podman)
test:
	tests/render/run.sh

install:
	install/install.sh

uninstall:
	install/uninstall.sh
