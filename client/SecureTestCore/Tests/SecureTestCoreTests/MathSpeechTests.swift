import XCTest
@testable import SecureTestCore

/// TTS slice 1, D-4 = (b): the LaTeX-to-words mapper. The subset is what
/// teachers write — and everything outside it reads as "math expression",
/// whole, never half.
final class MathSpeechTests: XCTestCase {
    private func say(_ tex: String) -> String { MathSpeech.words(tex) }

    func testNumbersAndArithmetic() {
        XCTAssertEqual(say("2 + 3 = 5"), "2 plus 3 equals 5")
        XCTAssertEqual(say("6 \\times 7"), "6 times 7")
        XCTAssertEqual(say("6 \\cdot 7"), "6 times 7")
        XCTAssertEqual(say("12 \\div 4"), "12 divided by 4")
        XCTAssertEqual(say("9 - 4"), "9 minus 4")
        XCTAssertEqual(say("3.5"), "3.5")
        XCTAssertEqual(say("57,600"), "57,600")
        XCTAssertEqual(say(".25"), ".25")
        XCTAssertEqual(say("12 × 3 ÷ 4 − 1"), "12 times 3 divided by 4 minus 1")
    }

    func testNegativeIsASign() {
        XCTAssertEqual(say("-3"), "negative 3")
        XCTAssertEqual(say("4 + -3"), "4 plus negative 3")
        XCTAssertEqual(say("(-2)"), "open paren negative 2 close paren")
        XCTAssertEqual(say("x - 2"), "x minus 2")
    }

    func testComparisons() {
        XCTAssertEqual(say("x < 3"), "x is less than 3")
        XCTAssertEqual(say("x > 3"), "x is greater than 3")
        XCTAssertEqual(say("x \\le 3"), "x is less than or equal to 3")
        XCTAssertEqual(say("x \\leq 3"), "x is less than or equal to 3")
        XCTAssertEqual(say("x \\geq 3"), "x is greater than or equal to 3")
        XCTAssertEqual(say("x ≤ 3"), "x is less than or equal to 3")
        XCTAssertEqual(say("x \\neq 3"), "x is not equal to 3")
        XCTAssertEqual(say("\\pi \\approx 3.14"), "pi is approximately equal to 3.14")
    }

    func testFractions() {
        XCTAssertEqual(say("\\frac{1}{2}"), "1 over 2")
        XCTAssertEqual(say("\\frac12"), "1 over 2")
        XCTAssertEqual(say("\\dfrac{a}{b}"), "a over b")
        XCTAssertEqual(say("\\frac{x+1}{2}"), "fraction x plus 1 over 2, end fraction")
    }

    func testPowers() {
        XCTAssertEqual(say("x^2"), "x squared")
        XCTAssertEqual(say("x^3"), "x cubed")
        XCTAssertEqual(say("x^n"), "x to the power n")
        XCTAssertEqual(say("2^{10}"), "2 to the power 10")
        XCTAssertEqual(say("x^{n+1}"), "x to the power n plus 1")
        XCTAssertEqual(say("x^{-1}"), "x to the power negative 1")
        XCTAssertEqual(say("x^23"), "x squared 3", "TeX takes one token: x^{2}3")
        XCTAssertEqual(say("3.5 \\times 10^{4}"), "3.5 times 10 to the power 4")
    }

    func testRoots() {
        XCTAssertEqual(say("\\sqrt{x}"), "square root of x")
        XCTAssertEqual(say("\\sqrt{49}"), "square root of 49")
        XCTAssertEqual(say("\\sqrt[3]{8}"), "cube root of 8")
        XCTAssertEqual(say("\\sqrt[n]{x}"), "nth root of x")
        XCTAssertEqual(say("\\sqrt{x+1}"), "square root of x plus 1, end root")
    }

    func testSubscripts() {
        XCTAssertEqual(say("x_1"), "x sub 1")
        XCTAssertEqual(say("a_{n}"), "a sub n")
        XCTAssertEqual(say("a_{n-1}"), "a sub n minus 1")
    }

    func testBrackets() {
        XCTAssertEqual(say("(x + 1)"), "open paren x plus 1 close paren")
        XCTAssertEqual(say("\\left( x \\right)"), "open paren x close paren")
        XCTAssertEqual(say("[0, 1]"), "open bracket 0, 1 close bracket")
    }

    func testGreek() {
        XCTAssertEqual(say("\\pi r^2"), "pi r squared")
        XCTAssertEqual(say("\\theta"), "theta")
        XCTAssertEqual(say("\\Delta x"), "capital delta x")
        XCTAssertEqual(say("\\varepsilon"), "epsilon")
        XCTAssertEqual(say("2π"), "2 pi")
    }

    func testDegreesAndPercent() {
        XCTAssertEqual(say("90^\\circ"), "90 degrees")
        XCTAssertEqual(say("90^{\\circ}"), "90 degrees")
        XCTAssertEqual(say("45°"), "45 degrees")
        XCTAssertEqual(say("50\\%"), "50 percent")
        XCTAssertEqual(say("37^\\circ\\text{C}"), "37 degrees C")
    }

    /// The shared K-12 macros (`GeneratedKatexMacros`), as written by hand.
    func testK12Macros() {
        XCTAssertEqual(say("90\\degree"), "90 degrees")
        XCTAssertEqual(say("\\half"), "one half")
        XCTAssertEqual(say("20\\percent"), "20 percent")
        XCTAssertEqual(say("\\plusminus 3"), "plus or minus 3")
    }

    func testTextAndSpacing() {
        XCTAssertEqual(say("5\\,\\text{cm}"), "5 cm")
        XCTAssertEqual(say("\\mathrm{H}_2\\mathrm{O}"), "H sub 2 O")
        XCTAssertEqual(say("a \\quad b"), "a b")
    }

    func testUnsupportedFallsBackWhole() {
        XCTAssertEqual(say("\\int_0^1 x\\,dx"), MathSpeech.fallback)
        XCTAssertEqual(say("\\begin{matrix} 1 \\end{matrix}"), MathSpeech.fallback)
        XCTAssertEqual(say("\\overline{AB}"), MathSpeech.fallback)
        XCTAssertEqual(say("x = 2 \\unknowncommand"), MathSpeech.fallback, "never half an expression")
        XCTAssertEqual(say("a & b"), MathSpeech.fallback)
    }

    func testMalformedFallsBack() {
        XCTAssertEqual(say("\\frac{1}{2"), MathSpeech.fallback)
        XCTAssertEqual(say("x}"), MathSpeech.fallback)
        XCTAssertEqual(say("x^"), MathSpeech.fallback)
        XCTAssertEqual(say("\\"), MathSpeech.fallback)
        XCTAssertEqual(say(""), MathSpeech.fallback)
        XCTAssertEqual(say("   "), MathSpeech.fallback)
    }
}
