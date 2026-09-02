import WidgetKit
import SwiftUI
import UIKit

extension Color {
    static let widgetBackground = Color(red: 31 / 255, green: 41 / 255, blue: 55 / 255)   // #1f2937
    static let widgetSecondary  = Color(red: 156 / 255, green: 163 / 255, blue: 175 / 255) // #9ca3af
    // White, like the arrow in Apple's own Weather widget. A green marker reads
    // as an active-location indicator and makes the widget feel like it is
    // tracking you, which it isn't — it renders whatever the app last resolved.
    static let widgetAccent     = Color.white
}

struct GeoTimeWidget: Widget {
    let kind = "GeoTimeWorldClocks"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            GeoTimeWidgetView(entry: entry)
        }
        .configurationDisplayName("World Clocks")
        .description("Your world clocks at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct RowMetrics {
    let cityFont: CGFloat
    let timeFont: CGFloat
    let detailFont: CGFloat    // one consistent size for day label / AM-PM
    let subtitleFont: CGFloat  // offset under the city in rich (two-line) mode
    let pinSize: CGFloat
    let rich: Bool             // two-line row (offset under the city name)
    let inlineOffset: Bool     // offset inline after the city (compact medium/large)
    let useFullDay: Bool       // full weekday name ("Tuesday") vs short ("Tue")
    let useFullShipName: Bool  // "Star of the Seas" vs "Star"
    let showLocalLabel: Bool   // "Local time" tag on the local row (single-line only)
    let showDeviceLabel: Bool  // "· Device time" tag on the device row (single-line only)
    let dayUnderTime: Bool     // small two-line: day label under the time, not beside it
    let dayTimeGap: CGFloat    // extra space between day label and time
    let hGap: CGFloat          // base horizontal gap between elements (tighter on small)
    let timeColW: CGFloat
    let periodColW: CGFloat
}

struct GeoTimeWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClockEntry

    // Row heights are measured from the fonts each layout actually uses rather
    // than assumed — see rowHeight(rich:). A fixed "stride" has to guess, and the
    // guess was 44 against a real two-line row of 29, so a third row was refused
    // roughly 30pt before it stopped fitting.
    private let richSpacing: CGFloat = 8     // VStack spacing in two-line mode
    private let compactSpacing: CGFloat = 4  // VStack spacing in single-line mode
    private let rowSlack: CGFloat = 2        // guard against rounding, per row
    private let footerStride: CGFloat = 16
    private var isSmall: Bool { family == .systemSmall }
    private var detailFont: CGFloat { isSmall ? 7 : 10 }   // smaller secondary text on small
    private var vPad: CGFloat { family == .systemLarge ? 14 : 0 }
    private var hPad: CGFloat { isSmall ? 0 : 12 }
    private var pinSize: CGFloat { isSmall ? 9 : 10 }

    // Font sizes live here so the height calculation and metrics() cannot drift.
    private func cityBase(rich: Bool) -> CGFloat { isSmall ? 14 : (rich ? 15 : 14) }
    private func subtitleSize() -> CGFloat { isSmall ? 9 : 10 }
    private func timeSize(rich: Bool) -> CGFloat { (rich && !isSmall) ? 17 : 14 }

    private func lineHeight(_ size: CGFloat) -> CGFloat {
        ceil(UIFont.systemFont(ofSize: size).lineHeight)
    }

    /// Height of one row as RowView actually lays it out. Rich rows stack the
    /// city over its offset (VStack spacing 1) beside the time; single-line rows
    /// share one baseline. Uses the unscaled city size, so this is an upper bound.
    private func rowHeight(rich: Bool) -> CGFloat {
        let time = lineHeight(timeSize(rich: rich))
        let city = lineHeight(cityBase(rich: rich))
        let stacked = rich ? city + 1 + lineHeight(subtitleSize()) : city
        return max(stacked, time) + rowSlack
    }

    /// Largest n with n*rowHeight + (n-1)*spacing <= available.
    private func rowsThatFit(in available: CGFloat, rich: Bool) -> Int {
        let h = rowHeight(rich: rich)
        let spacing = rich ? richSpacing : compactSpacing
        return max(1, Int((available + spacing) / (h + spacing)))
    }

    private func width(_ s: String, _ size: CGFloat, weight: UIFont.Weight = .regular, mono: Bool = false) -> CGFloat {
        let font = mono ? UIFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
                        : UIFont.systemFont(ofSize: size, weight: weight)
        return (s as NSString).size(withAttributes: [.font: font]).width
    }

    var body: some View {
        GeometryReader { geo in
            let rows = entry.rows
            let usableH = geo.size.height - vPad * 2

            // Two-line rows (offset under the city) when they all fit — for small
            // and large. Medium keeps its inline-offset single-line look.
            // n rows occupy n heights and n-1 gaps, not n of each.
            let twoLineFits = rows.count <= rowsThatFit(in: usableH, rich: true)
            let rich = family != .systemMedium && twoLineFits

            let maxRows = rowsThatFit(in: usableH, rich: rich)
            let fitCount = rows.count > maxRows
                ? rowsThatFit(in: usableH - footerStride, rich: rich)
                : maxRows
            let result = ZoneRowResolver.fit(rows, maxRows: fitCount)
            let metrics = self.metrics(for: result.visible, usableW: geo.size.width - hPad * 2, rich: rich)

            ZStack(alignment: .bottomTrailing) {
                VStack(alignment: .leading, spacing: rich ? richSpacing : compactSpacing) {
                    ForEach(result.visible) { row in
                        RowView(row: row, metrics: metrics)
                    }
                }
                // Vertically center the rows (looks natural with just a few); when
                // overflowing, top-align so the "+N more" doesn't collide.
                .frame(maxWidth: .infinity, maxHeight: .infinity,
                       alignment: result.overflow > 0 ? .topLeading : .leading)

                if result.overflow > 0 {
                    Text("+\(result.overflow) more")
                        .font(.system(size: detailFont))
                        .foregroundColor(.widgetSecondary)
                }
            }
            .padding(.horizontal, hPad)
            .padding(.vertical, vPad)
        }
        .widgetContainerBackground(Color.widgetBackground)
    }

    // Fixed right-hand columns + one city font size that fits every row's name
    // (plus its inline offset, where shown).
    private func metrics(for rows: [WidgetRow], usableW: CGFloat, rich: Bool) -> RowMetrics {
        let timeFont = timeSize(rich: rich)
        let inlineOffset = !isSmall && !rich
        let hasPeriod = rows.contains { !$0.timePeriod.isEmpty }
        let periodColW = hasPeriod ? width("PM", detailFont, weight: .medium, mono: true) + 2 : 0
        let timeColW = width("88:88", timeFont, mono: true) + (hasPeriod ? periodColW + 2 : 0)
        let subtitleFont = subtitleSize()   // ←— RICH OFFSET-UNDER-CITY SIZE LEVER

        // Max city font. Small has its own value (stays compact even when it
        // expands to two lines, so single-line names still fit); large rich a
        // little larger.  ←— SMALL CITY SIZE LEVER
        let cityBase = self.cityBase(rich: rich)
        let dayTimeGap: CGFloat = isSmall ? 4 : 6   // ←— DAY↔TIME GAP LEVER
        let hGap: CGFloat = isSmall ? 3 : 5
        // Small two-line: the day label tucks under the time (line 2) rather than
        // beside it, so it no longer competes with the city name for line-1 width.
        let dayUnderTime = isSmall && rich

        // City width is limited only by each row's OWN right-side content, so a
        // long name on a row with no day label can use the space that only other
        // rows' day labels occupy. The uniform font is the largest that fits all.
        // Computed twice (short vs full day names): full names are used only when
        // they don't shrink the city — city size wins the trade-off.
        let clusterW = usableW - timeColW - (hGap * 2 + 4)
        func cityScale(fullDay: Bool, localLabel: Bool, deviceLabel: Bool,
                       fullShipName: Bool) -> CGFloat {
            var scale: CGFloat = 1
            for r in rows {
                var reserved: CGFloat = 0
                // The marker (pin/phone/ship) sits on line 1 in every layout, and
                // a merged local+ship row carries two of them.
                if r.isLocal || r.isDevice || r.isShip { reserved += pinSize + hGap }
                if r.isShip && r.isLocal { reserved += pinSize + hGap * 0.5 }
                // Offset + optional labels are on line 1 only in single-line rows;
                // in rich rows they live on line 2 (free of the city's width).
                if !rich {
                    if r.isLocal {
                        if localLabel { reserved += width("Local time", detailFont) + hGap }
                    } else if inlineOffset {
                        reserved += width(r.relativeText, detailFont) + hGap
                        if r.isDevice && deviceLabel { reserved += width("· Device time", detailFont) + hGap }
                    }
                }
                // When the day tucks under the time it doesn't take line-1 width.
                if !dayUnderTime, let day = fullDay ? r.weekdayFull : r.weekdayShort {
                    reserved += width(day, detailFont) + dayTimeGap
                }
                let availName = clusterW - reserved
                // A ship is the one row with two forms of its own name. The full
                // one is preferred and the short one is the fallback, so the
                // abbreviation is a response to running out of width rather than
                // a permanent choice.
                let name = fullShipName ? r.name : (r.shortName ?? r.name)
                let nameW = width(name, cityBase)
                if nameW > 0 { scale = min(scale, availName / nameW) }
            }
            return scale
        }
        // Names are decided BEFORE the optional labels, because a name is content
        // and a label is garnish: it would be wrong to keep "Tuesday" at the cost
        // of abbreviating a vessel. The floor is the short-name scale — the form
        // guaranteed to fit — and the full name is used whenever it holds that
        // same scale, which it does whenever some other row is the binding
        // constraint. In practice that means full names on medium and large, and
        // "Star" only on the small widget where width really has run out.
        let shortNameBase = min(1, cityScale(fullDay: false, localLabel: false,
                                             deviceLabel: false, fullShipName: false))
        let useFullShipName = min(1, cityScale(fullDay: false, localLabel: false,
                                               deviceLabel: false, fullShipName: true))
            >= shortNameBase - 0.001

        // Optional labels (full day names, "Local time" / "Device time") are added
        // only when they don't shrink the city — city size wins the trade-off.
        let clampedBase = min(1, cityScale(fullDay: false, localLabel: false,
                                           deviceLabel: false, fullShipName: useFullShipName))
        let useFullDay = min(1, cityScale(fullDay: true, localLabel: false,
                                          deviceLabel: false, fullShipName: useFullShipName)) >= clampedBase - 0.001
        let showLocalLabel = !rich && min(1, cityScale(fullDay: false, localLabel: true,
                                                       deviceLabel: false, fullShipName: useFullShipName)) >= clampedBase - 0.001
        // In rich, the label lives on line 2: fine on large, too narrow on small.
        let showDeviceLabel = rich
            ? !isSmall
            : min(1, cityScale(fullDay: false, localLabel: false,
                               deviceLabel: true, fullShipName: useFullShipName)) >= clampedBase - 0.001
        let cityFont = max(9, min(cityBase, cityBase * clampedBase))

        return RowMetrics(cityFont: cityFont, timeFont: timeFont, detailFont: detailFont,
                          subtitleFont: subtitleFont, pinSize: pinSize, rich: rich,
                          inlineOffset: inlineOffset, useFullDay: useFullDay,
                          useFullShipName: useFullShipName,
                          showLocalLabel: showLocalLabel, showDeviceLabel: showDeviceLabel,
                          dayUnderTime: dayUnderTime, dayTimeGap: dayTimeGap, hGap: hGap,
                          timeColW: timeColW, periodColW: periodColW)
    }
}

private struct RowView: View {
    let row: WidgetRow
    let metrics: RowMetrics

    var body: some View {
        if metrics.rich && metrics.dayUnderTime {
            // Small two-line: two independent full-width rows, so the full-word day
            // on line 2 never competes with the city name on line 1.
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
                    cityLine
                    Spacer(minLength: 4)
                    time
                }
                HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
                    subtitle
                    if let weekday = row.weekdayFull {
                        Spacer(minLength: 4)
                        Text(weekday)
                            .font(.system(size: metrics.detailFont))
                            .foregroundColor(.widgetSecondary)
                            .lineLimit(1)
                    }
                }
            }
        } else if metrics.rich {
            // Large two-line: city/offset on the left; day · time on the right,
            // both blocks aligned on the city/time baseline.
            HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
                VStack(alignment: .leading, spacing: 1) {
                    cityLine
                    subtitle
                }
                Spacer(minLength: 4)
                rightGroup
            }
        } else {
            // Single line: everything sits on one shared baseline.
            HStack(alignment: .lastTextBaseline, spacing: metrics.hGap) {
                cityLine
                Spacer(minLength: 4)
                rightGroup
            }
        }
    }

    // Offset (+ "· Device time" where it fits) shown under the city in rich rows.
    private var subtitle: some View {
        HStack(spacing: 4) {
            Text(row.relativeText)
                .font(.system(size: metrics.subtitleFont))
                .foregroundColor(.widgetSecondary)
                .lineLimit(1)
            if row.isDevice && metrics.showDeviceLabel {
                Text("· Device time")
                    .font(.system(size: metrics.subtitleFont))
                    .foregroundColor(.widgetSecondary)
                    .lineLimit(1)
            }
        }
    }

    // Day · time · AM-PM, sharing a baseline so they read as one line.
    private var rightGroup: some View {
        HStack(alignment: .lastTextBaseline, spacing: 0) {
            if let weekday = metrics.useFullDay ? row.weekdayFull : row.weekdayShort {
                Text(weekday)
                    .font(.system(size: metrics.detailFont))
                    .foregroundColor(.widgetSecondary)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.trailing, metrics.dayTimeGap)
            }
            time
        }
    }

    /// The full name unless the layout could not afford it; see metrics.
    private var displayName: String {
        metrics.useFullShipName ? row.name : (row.shortName ?? row.name)
    }

    // City name, then either the location pin (local row) or the inline offset
    // ("Vancouver −8 hrs"). The offset reads as a lighter span on the name.
    private var cityLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
            Text(displayName)
                .font(.system(size: metrics.cityFont, weight: metrics.rich ? .medium : .regular))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.85)   // backstop against measurement rounding
            if metrics.rich {
                // Two-line: marker sits on line 1 after the city; labels on line 2.
                marker(for: row)
            } else {
                // Single-line: city – offset/label(s) – marker (at the end).
                if row.isLocal {
                    if metrics.showLocalLabel { detailText("Local time") }
                } else if metrics.inlineOffset {
                    detailText(row.relativeText)
                    if row.isDevice && metrics.showDeviceLabel { detailText("· Device time") }
                }
                marker(for: row)
            }
        }
    }

    private func detailText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: metrics.detailFont))
            .foregroundColor(.widgetSecondary)
            .lineLimit(1)
            .fixedSize()
    }

    // Time cluster: tabular digits + a fixed-width AM/PM column, sharing a
    // baseline. No outer fixed width — the cluster right-aligns at the row's
    // trailing edge, so colons still line up across rows and the day label
    // (when present) hugs the time instead of sitting in a separate column.
    private var time: some View {
        HStack(alignment: .lastTextBaseline, spacing: 1) {
            Text(row.timeDigits)
                .font(.system(size: metrics.timeFont).monospacedDigit())
                .foregroundColor(.white)
                .lineLimit(1)
            if !row.timePeriod.isEmpty {
                Text(row.timePeriod)
                    .font(.system(size: metrics.detailFont, weight: .medium).monospacedDigit())
                    .foregroundColor(.widgetSecondary)
                    .frame(width: metrics.periodColW, alignment: .trailing)
            }
        }
        .fixedSize()   // never wrap the time; the city yields space instead
    }

    // A merged row is both local and ship, and shows BOTH marks: the ship says
    // what you are aboard, the pin says that it is also where you are. Dropping
    // the pin there was tempting — "implied by it being the base row" — but the
    // two answer different questions, and a row that means "this vessel is your
    // local time" should say both things rather than leave one inferred.
    @ViewBuilder private func marker(for row: WidgetRow) -> some View {
        if row.isShip && row.isLocal {
            HStack(spacing: metrics.hGap * 0.5) { shipMark; pin }
        } else if row.isShip { shipMark }
        else if row.isLocal { pin }
        else if row.isDevice { phone }
    }

    @ViewBuilder private var pin: some View {
        Image(systemName: "location.fill")
            .font(.system(size: metrics.pinSize))
            .foregroundColor(.widgetAccent)
    }

    // Phone emoji marking the device's own timezone.
    @ViewBuilder private var phone: some View {
        Text("📱").font(.system(size: metrics.pinSize))
    }

    // Ship mark. A custom shape rather than an SF Symbol: `ferry.fill` and
    // `sailboat.fill` both arrived with SF Symbols 4 on iOS 16, and this target
    // is 15.0 — raising the deployment target for one glyph would be the tail
    // wagging the dog. Drawing it also guarantees it matches Android exactly,
    // where the same path ships as ic_ship.xml.
    @ViewBuilder private var shipMark: some View {
        ShipShape()
            .fill(Color.widgetAccent)
            .frame(width: metrics.pinSize * 1.2, height: metrics.pinSize * 1.2)
    }
}

/// Font Awesome's "ship" (free, solid), in its native 640×512 box.
///
/// The same glyph the World Clock rows draw, so the widget and the app show one
/// ship rather than two different ones. It replaces a hand-rolled trapezoid hull
/// with a box on top, which at 4× magnification read unmistakably as a toy boat.
///
/// The old shape was chunky on the theory that a detailed silhouette would turn
/// to mud at ~10pt. Worth testing rather than assuming, and it does not: rendered
/// at 13px beside the alternatives, this stays recognisably a ship — a raked bow
/// and a superstructure survive, which is all the read needs. Still drawn rather
/// than an SF Symbol, because ferry.fill wants iOS 16 and this target is 15.0,
/// and because drawing it keeps Android identical (res/drawable/ic_ship.xml).
struct ShipShape: Shape {
    func path(in rect: CGRect) -> Path {
        // Fit the glyph's box into the frame without distorting it, and centre
        // what is left over — the artwork is 1.25:1 in a square frame.
        let s = min(rect.width / 640, rect.height / 512)
        let ox = rect.minX + (rect.width - 640 * s) / 2
        let oy = rect.minY + (rect.height - 512 * s) / 2
        func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: ox + x * s, y: oy + y * s)
        }

        var p = Path()
        p.move(to: P(272, 0))
        p.addCurve(to: P(224, 48), control1: P(245.5, 0), control2: P(224, 21.5))
        p.addLine(to: P(224, 64))
        p.addLine(to: P(208, 64))
        p.addCurve(to: P(128, 144), control1: P(163.8, 64), control2: P(128, 99.8))
        p.addLine(to: P(128, 252.8))
        p.addLine(to: P(106.4, 261.4))
        p.addCurve(to: P(89, 298.9), control1: P(91.6, 267.3), control2: P(83.9, 283.8))
        p.addCurve(to: P(136.7, 382), control1: P(99.4, 330.2), control2: P(115.8, 358.2))
        p.addCurve(to: P(200, 368), control1: P(156.8, 372.8), control2: P(178.4, 368.1))
        p.addCurve(to: P(294.4, 399.4), control1: P(233.1, 367.8), control2: P(266.3, 378.2))
        p.addLine(to: P(296, 400.6))
        p.addLine(to: P(296, 185.6))
        p.addLine(to: P(192, 227.2))
        p.addLine(to: P(192, 144))
        p.addCurve(to: P(208, 128), control1: P(192, 135.2), control2: P(199.2, 128))
        p.addLine(to: P(432, 128))
        p.addCurve(to: P(448, 144), control1: P(440.8, 128), control2: P(448, 135.2))
        p.addLine(to: P(448, 227.2))
        p.addLine(to: P(344, 185.6))
        p.addLine(to: P(344, 400.6))
        p.addLine(to: P(345.6, 399.4))
        p.addCurve(to: P(438, 368), control1: P(373.1, 378.7), control2: P(405.5, 368.2))
        p.addCurve(to: P(503.3, 382), control1: P(460.3, 367.9), control2: P(482.6, 372.5))
        p.addCurve(to: P(551, 298.9), control1: P(524.2, 358.3), control2: P(540.6, 330.2))
        p.addCurve(to: P(533.6, 261.4), control1: P(556, 283.7), control2: P(548.4, 267.3))
        p.addLine(to: P(512, 252.8))
        p.addLine(to: P(512, 144))
        p.addCurve(to: P(432, 64), control1: P(512, 99.8), control2: P(476.2, 64))
        p.addLine(to: P(416, 64))
        p.addLine(to: P(416, 48))
        p.addCurve(to: P(368, 0), control1: P(416, 21.5), control2: P(394.5, 0))
        p.addLine(to: P(272, 0))
        p.closeSubpath()
        p.move(to: P(403.4, 476.1))
        p.addCurve(to: P(474.6, 476.1), control1: P(424.7, 460), control2: P(453.3, 460))
        p.addCurve(to: P(541.8, 509.4), control1: P(493.6, 490.5), control2: P(516.5, 504.3))
        p.addCurve(to: P(622.5, 490.3), control1: P(568.3, 514.8), control2: P(596.1, 510.2))
        p.addCurve(to: P(627.2, 456.7), control1: P(633.1, 482.3), control2: P(635.2, 467.3))
        p.addCurve(to: P(593.6, 452), control1: P(619.2, 446.1), control2: P(604.2, 444))
        p.addCurve(to: P(551.3, 462.3), control1: P(578.7, 463.2), control2: P(565, 465.1))
        p.addCurve(to: P(503.5, 437.7), control1: P(536.4, 459.3), control2: P(520.4, 450.4))
        p.addCurve(to: P(374.5, 437.7), control1: P(465.1, 408.7), control2: P(413, 408.7))
        p.addCurve(to: P(320, 464), control1: P(350.5, 455.8), control2: P(333.8, 464))
        p.addCurve(to: P(265.5, 437.7), control1: P(306.2, 464), control2: P(289.5, 455.8))
        p.addCurve(to: P(136.5, 437.7), control1: P(227.1, 408.7), control2: P(175, 408.7))
        p.addCurve(to: P(77.6, 463.4), control1: P(114.9, 454), control2: P(95.2, 463.5))
        p.addCurve(to: P(46.4, 451.9), control1: P(68, 463.3), control2: P(57.7, 460.4))
        p.addCurve(to: P(12.8, 456.6), control1: P(35.8, 443.9), control2: P(20.8, 446))
        p.addCurve(to: P(17.6, 490.3), control1: P(4.8, 467.2), control2: P(7, 482.3))
        p.addCurve(to: P(77.4, 511.4), control1: P(36.7, 504.7), control2: P(57, 511.3))
        p.addCurve(to: P(165.5, 476.1), control1: P(111.3, 511.6), control2: P(141.7, 494))
        p.addCurve(to: P(236.7, 476.1), control1: P(186.8, 460), control2: P(215.4, 460))
        p.addCurve(to: P(320.1, 512), control1: P(260.9, 494.4), control2: P(289, 512))
        p.addCurve(to: P(403.5, 476.1), control1: P(351.2, 512), control2: P(379.2, 494.3))
        p.closeSubpath()
        return p
    }
}

extension View {
    @ViewBuilder
    func widgetContainerBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(color, for: .widget)
        } else {
            self.background(color)
        }
    }
}
