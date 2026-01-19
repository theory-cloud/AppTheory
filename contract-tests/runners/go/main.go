package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	var fixturesRoot string
	flag.StringVar(&fixturesRoot, "fixtures", "contract-tests/fixtures", "fixtures root directory")
	flag.Parse()

	fixtures, err := loadFixtures(fixturesRoot)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	var failed []Fixture
	for _, f := range fixtures {
		if err := runFixture(f); err != nil {
			printFailure(f, err)
			failed = append(failed, f)
		}
	}

	if len(failed) > 0 {
		summarizeFailures(failed)
		os.Exit(1)
	}

	fmt.Printf("contract-tests(go): PASS (%d fixtures)\n", len(fixtures))
}

