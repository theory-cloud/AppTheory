package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	os.Exit(run())
}

func run() int {
	var fixturesRoot string
	var fixtureID string
	var fixtureFilter string
	flag.StringVar(&fixturesRoot, "fixtures", "contract-tests/fixtures", "fixtures root directory")
	flag.StringVar(&fixtureID, "id", "", "run exactly one fixture by id")
	flag.StringVar(&fixtureFilter, "filter", "", "run exactly one fixture by id")
	flag.Parse()

	fixtures, err := loadFixtures(fixturesRoot)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	selectedID, err := selectedFixtureID(fixtureID, fixtureFilter)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if selectedID != "" {
		fixtures, err = filterFixturesByID(fixtures, selectedID)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
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
		return 1
	}

	fmt.Printf("contract-tests(go): PASS (%d fixtures)\n", len(fixtures))
	return 0
}

func selectedFixtureID(id string, filter string) (string, error) {
	id = strings.TrimSpace(id)
	filter = strings.TrimSpace(filter)
	if id != "" && filter != "" && id != filter {
		return "", fmt.Errorf("fixture id mismatch: --id %q != --filter %q", id, filter)
	}
	if id != "" {
		return id, nil
	}
	return filter, nil
}

func filterFixturesByID(fixtures []Fixture, id string) ([]Fixture, error) {
	var matches []Fixture
	for _, fixture := range fixtures {
		if fixture.ID == id {
			matches = append(matches, fixture)
		}
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("fixture id %q matched %d fixtures", id, len(matches))
	}
	return matches, nil
}
