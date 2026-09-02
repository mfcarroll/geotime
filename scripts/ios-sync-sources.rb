#!/usr/bin/env ruby
# Ensures every Swift source on disk is in the Xcode target that should compile it.
#
# `npx cap sync` copies web assets and wires plugin pods, but it does not touch
# the project's source list — so a new .swift file added to ios/App/App or
# ios/App/Shared is invisible to the build until something adds it to
# project.pbxproj. That failure is silent and nasty: the file simply isn't
# compiled, so a Capacitor plugin it defines is never registered and the JS call
# rejects at runtime, disabling a feature with no build error anywhere.
#
# (That is not hypothetical — ShipTimePlugin.swift was written, compiled fine in
# isolation, and would have shipped with iOS ship time quietly dead.)
#
# ios-add-widget-target.rb also lists sources, but it exits early once the widget
# target exists, so it cannot fix an existing project. This one is safe to run
# any time and does nothing when everything is already wired.
#
# Uses the `xcodeproj` gem bundled with CocoaPods, e.g.:
#   GEM_PATH=/opt/homebrew/Cellar/cocoapods/1.16.2_2/libexec ruby scripts/ios-sync-sources.rb

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../ios/App/App.xcodeproj', __dir__)
IOS_ROOT = File.expand_path('../ios/App', __dir__)

# directory => the targets that must compile everything in it
LAYOUT = {
  'App'            => %w[App],
  'Shared'         => %w[App GeoTimeWidget],   # one implementation, both binaries
  'GeoTimeWidget'  => %w[GeoTimeWidget],
}.freeze

project = Xcodeproj::Project.open(PROJECT_PATH)
targets = {}
LAYOUT.values.flatten.uniq.each do |name|
  target = project.targets.find { |t| t.name == name }
  raise "#{name} target not found — run ios-add-widget-target.rb first" unless target
  targets[name] = target
end

added = []

LAYOUT.each do |dir, target_names|
  sources = Dir.glob(File.join(IOS_ROOT, dir, '*.swift')).map { |p| File.basename(p) }.sort
  next if sources.empty?

  group = project.main_group.find_subpath(dir, true)
  group.set_path(dir) if group.path.nil?

  sources.each do |file|
    # One file reference per path, reused across targets — two references to the
    # same file compile it twice and produce duplicate-symbol errors.
    ref = group.files.find { |f| f.path == file } || group.new_reference(file)

    target_names.each do |name|
      target = targets[name]
      compiled = target.source_build_phase.files.any? do |bf|
        bf.file_ref && File.basename(bf.file_ref.path.to_s) == file
      end
      next if compiled

      target.add_file_references([ref])
      added << "#{dir}/#{file} -> #{name}"
    end
  end
end

if added.empty?
  puts 'All Swift sources are already in their targets; nothing to do.'
else
  project.save
  puts "Added #{added.length} source membership(s):"
  added.each { |line| puts "  #{line}" }
end
